use std::{fs::File, io, mem::size_of, os::windows::io::AsRawHandle, ptr::null_mut};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, GetLastError, HANDLE, LocalFree,
    },
    Security::{
        ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, AddAccessAllowedAceEx,
        Authorization::{GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo},
        CONTAINER_INHERIT_ACE, CreateWellKnownSid, DACL_SECURITY_INFORMATION, EqualSid,
        GetLengthSid, GetTokenInformation, InitializeAcl, IsValidSid, OBJECT_INHERIT_ACE,
        OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        PSID, SECURITY_MAX_SID_SIZE, TOKEN_QUERY, TOKEN_USER, TokenUser, WinLocalSystemSid,
    },
    Storage::FileSystem::FILE_ALL_ACCESS,
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

const MAX_TOKEN_BYTES: usize = 64 * 1024;

struct Token(HANDLE);
impl Drop for Token {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct SecurityDescriptor(PSECURITY_DESCRIPTOR);
impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

struct UserSid {
    storage: Vec<usize>,
    offset: usize,
}
impl UserSid {
    fn as_ptr(&self) -> PSID {
        unsafe {
            self.storage
                .as_ptr()
                .cast::<u8>()
                .add(self.offset)
                .cast_mut()
                .cast()
        }
    }
}

fn current_user_sid() -> io::Result<UserSid> {
    let mut handle = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = Token(handle);
    if token.0.is_null() {
        return Err(io::Error::other("Windows returned an empty process token"));
    }

    let mut required = 0u32;
    if unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut required) } != 0 {
        return Err(io::Error::other(
            "Windows returned an invalid token size response",
        ));
    }
    let error = unsafe { GetLastError() };
    if error != ERROR_INSUFFICIENT_BUFFER {
        return Err(io::Error::from_raw_os_error(error as i32));
    }
    if (required as usize) < size_of::<TOKEN_USER>() || required as usize > MAX_TOKEN_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Process token exceeds the bounded buffer",
        ));
    }
    // usize storage keeps TOKEN_USER pointer fields correctly aligned on both Windows architectures.
    let words = (required as usize).div_ceil(size_of::<usize>());
    let mut storage = Vec::<usize>::new();
    storage
        .try_reserve_exact(words)
        .map_err(|error| io::Error::other(error.to_string()))?;
    storage.resize(words, 0);
    let capacity = storage.len() * size_of::<usize>();
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            storage.as_mut_ptr().cast(),
            capacity as u32,
            &mut required,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if (required as usize) < size_of::<TOKEN_USER>() || required as usize > capacity {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows returned an invalid token length",
        ));
    }

    let user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
    let sid = user.User.Sid;
    let begin = storage.as_ptr() as usize;
    let end = begin + required as usize;
    let address = sid as usize;
    // The returned SID must remain within the token buffer while it is compared.
    if address < begin || address.checked_add(8).is_none_or(|n| n > end) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "User SID is outside its token buffer",
        ));
    }
    let sid_bytes = 8 + 4 * usize::from(unsafe { sid.cast::<u8>().add(1).read() });
    if address.checked_add(sid_bytes).is_none_or(|n| n > end) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "User SID exceeds its token buffer",
        ));
    }
    if unsafe { IsValidSid(sid) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows returned an invalid user SID",
        ));
    }
    let length = unsafe { GetLengthSid(sid) } as usize;
    if length < 8 || address.checked_add(length).is_none_or(|n| n > end) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "User SID length exceeds its token buffer",
        ));
    }
    Ok(UserSid {
        storage,
        offset: address - begin,
    })
}

pub fn is_current_user(file: &File) -> bool {
    let mut descriptor = SecurityDescriptor(null_mut());
    let mut owner = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor.0,
        )
    };
    if status != ERROR_SUCCESS
        || descriptor.0.is_null()
        || owner.is_null()
        || unsafe { IsValidSid(owner) } == 0
    {
        return false;
    }
    let Ok(user) = current_user_sid() else {
        return false;
    };
    unsafe { EqualSid(owner, user.as_ptr()) != 0 }
}

/// The local system account's SID (S-1-5-18).
struct SystemSid([usize; (SECURITY_MAX_SID_SIZE as usize).div_ceil(size_of::<usize>())]);
impl SystemSid {
    fn new() -> io::Result<Self> {
        let mut sid = Self([0; (SECURITY_MAX_SID_SIZE as usize).div_ceil(size_of::<usize>())]);
        let mut length = SECURITY_MAX_SID_SIZE;
        // SAFETY: the buffer holds SECURITY_MAX_SID_SIZE bytes, the length the call is given.
        let made =
            unsafe { CreateWellKnownSid(WinLocalSystemSid, null_mut(), sid.as_ptr(), &mut length) };
        if made == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(sid)
    }
    fn as_ptr(&mut self) -> PSID {
        self.0.as_mut_ptr().cast()
    }
}

/// Makes the folder `file` is open on the current user's, and open to that user and to the system alone, whatever its
/// parent lets other accounts do: a protected access list of two entries, which every file and folder made in it
/// inherits.
pub fn make_private(file: &File) -> io::Result<()> {
    let user = current_user_sid()?;
    let mut system = SystemSid::new()?;
    // An entry is its header and access mask, then its SID in place of SidStart.
    let entry = |sid: PSID| {
        (size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>()) as u32 + unsafe { GetLengthSid(sid) }
    };
    let length = size_of::<ACL>() as u32 + entry(user.as_ptr()) + entry(system.as_ptr());
    // u32 storage keeps the list and its entries on the 4-byte boundaries the system puts them on.
    let mut storage = vec![0u32; (length as usize).div_ceil(size_of::<u32>())];
    let list: *mut ACL = storage.as_mut_ptr().cast();
    let inherited = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
    // SAFETY: the list's storage holds `length` bytes, which the two entries are counted into; the SIDs are valid.
    let made = unsafe {
        InitializeAcl(list, length, ACL_REVISION) != 0
            && AddAccessAllowedAceEx(
                list,
                ACL_REVISION,
                inherited,
                FILE_ALL_ACCESS,
                user.as_ptr(),
            ) != 0
            && AddAccessAllowedAceEx(
                list,
                ACL_REVISION,
                inherited,
                FILE_ALL_ACCESS,
                system.as_ptr(),
            ) != 0
    };
    if !made {
        return Err(io::Error::last_os_error());
    }
    let what = OWNER_SECURITY_INFORMATION
        | DACL_SECURITY_INFORMATION
        | PROTECTED_DACL_SECURITY_INFORMATION;
    // SAFETY: the handle is open with the rights to change its owner and access list; the SID and list live through the call.
    let status = unsafe {
        SetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            what,
            user.as_ptr(),
            null_mut(),
            list,
            null_mut(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    if !is_current_user(file) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Archive owner verification failed",
        ));
    }
    Ok(())
}

pub fn assign_current_user(file: &File) -> io::Result<()> {
    let user = current_user_sid()?;
    let status = unsafe {
        SetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            user.as_ptr(),
            null_mut(),
            null_mut(),
            null_mut(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    if !is_current_user(file) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Archive owner verification failed",
        ));
    }
    Ok(())
}

/// Whether the access list of what is at `path` is protected, and whom each of its entries lets in: "user" (the current
/// user), "system", or "other" (another account, or an entry of another kind than one that lets in).
#[cfg(test)]
pub(crate) fn access_of(path: &std::path::Path) -> io::Result<(bool, Vec<&'static str>)> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::{
        Security::{
            ACE_HEADER, ACL_SIZE_INFORMATION, AclSizeInformation, GetAce, GetAclInformation,
            GetSecurityDescriptorControl, SE_DACL_PROTECTED,
        },
        Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, READ_CONTROL},
    };
    let file = std::fs::OpenOptions::new()
        .access_mode(READ_CONTROL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    let mut descriptor = SecurityDescriptor(null_mut());
    let mut list: *mut ACL = null_mut();
    // SAFETY: the handle is open with READ_CONTROL; the descriptor the list lies in is freed with `descriptor`.
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut list,
            null_mut(),
            &mut descriptor.0,
        )
    };
    if status != ERROR_SUCCESS || list.is_null() {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let (mut control, mut revision) = (0u16, 0u32);
    let mut size = ACL_SIZE_INFORMATION::default();
    // SAFETY: the descriptor and its list live until `descriptor` is dropped; `size` is the structure asked for.
    let read = unsafe {
        GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) != 0
            && GetAclInformation(
                list,
                (&raw mut size).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            ) != 0
    };
    if !read {
        return Err(io::Error::last_os_error());
    }
    let user = current_user_sid()?;
    let mut system = SystemSid::new()?;
    let mut whom = Vec::new();
    for index in 0..size.AceCount {
        let mut entry = null_mut();
        // SAFETY: the index is below the list's count of entries, which live with the list.
        if unsafe { GetAce(list, index, &mut entry) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: every entry starts with its header; one that lets in (type 0, ACCESS_ALLOWED_ACE_TYPE in winnt.h)
        // has its SID at SidStart.
        let (kind, sid): (u8, PSID) = unsafe {
            let offset = std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
            (
                (*entry.cast::<ACE_HEADER>()).AceType,
                entry.cast::<u8>().add(offset).cast(),
            )
        };
        whom.push(if kind != 0 {
            "other"
        } else if unsafe { EqualSid(sid, user.as_ptr()) } != 0 {
            "user"
        } else if unsafe { EqualSid(sid, system.as_ptr()) } != 0 {
            "system"
        } else {
            "other"
        });
    }
    Ok((control & SE_DACL_PROTECTED != 0, whom))
}
