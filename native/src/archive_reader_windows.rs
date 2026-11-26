//! The system's archive reader (system_archive.rs), started with its restrictions in place before its first
//! instruction.
//!
//! Windows creates the reader suspended and already inside its job (PROC_THREAD_ATTRIBUTE_JOB_LIST), whose limits are
//! set before the reader exists, with a token of its own and with no handle of the engine's but the three it is given
//! (PROC_THREAD_ATTRIBUTE_HANDLE_LIST). Its first thread runs only once Windows says the reader is in that job.
//!
//! - The job ends the reader with the engine, lets it start no program, shows no error window for it, keeps it from
//!   the clipboard, the desktop and the computer's settings, and bounds its memory.
//! - The token is the engine's, restricted (Restricted Tokens, in the Windows security documentation): every access is
//!   checked a second time against the restricting SIDs alone, and the folders of the user's own profile let in the user
//!   and the system only. It holds no privilege but bypassing traverse checking, and runs at low integrity (Mandatory
//!   Integrity Control): it can write nowhere the user can, and open none of the user's programs.
//! - It starts with no console, so no console host runs beside it.

use std::{
    ffi::OsStr,
    fs::File,
    io, iter,
    marker::PhantomData,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::{GENERIC_ALL, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0},
    Security::{
        ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, AddAccessAllowedAce, CreateRestrictedToken,
        CreateWellKnownSid, DISABLE_MAX_PRIVILEGE, GetLengthSid, GetTokenInformation,
        InitializeAcl, PSID, SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES, SetTokenInformation,
        TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DEFAULT_DACL, TOKEN_DUPLICATE,
        TOKEN_GROUPS, TOKEN_INFORMATION_CLASS, TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_USER,
        TokenDefaultDacl, TokenGroups, TokenIntegrityLevel, TokenUser, WELL_KNOWN_SID_TYPE,
        WinBuiltinUsersSid, WinLocalSystemSid, WinLowLabelSid, WinRestrictedCodeSid, WinWorldSid,
    },
    System::{
        JobObjects::{
            CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
            JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOB_OBJECT_UILIMIT, JOB_OBJECT_UILIMIT_DESKTOP,
            JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS,
            JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_HANDLES,
            JOB_OBJECT_UILIMIT_READCLIPBOARD, JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS,
            JOB_OBJECT_UILIMIT_WRITECLIPBOARD, JOBOBJECT_BASIC_UI_RESTRICTIONS,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicUIRestrictions,
            JobObjectExtendedLimitInformation, SetInformationJobObject,
        },
        SystemServices::{SE_GROUP_INTEGRITY, SE_GROUP_LOGON_ID},
        Threading::{
            CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW, DETACHED_PROCESS,
            DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess,
            GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList, OpenProcessToken,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION,
            ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess,
            UpdateProcThreadAttribute, WaitForSingleObject,
        },
    },
};

/// The memory the reader may take: RAR's own dictionary is at most a quarter of this in common archives.
const MEMORY: usize = 1 << 30;
/// The job's limits: it ends what is in it when its last handle closes (the engine's, with the engine), holds one
/// process, bounds that process's memory and shows no error window for it.
const LIMITS: JOB_OBJECT_LIMIT = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
    | JOB_OBJECT_LIMIT_PROCESS_MEMORY
    | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
/// What the job keeps from the reader: other programs' windows and handles, the clipboard, the desktop, the display's,
/// the computer's and its session's settings.
const SCREEN: JOB_OBJECT_UILIMIT = JOB_OBJECT_UILIMIT_DESKTOP
    | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
    | JOB_OBJECT_UILIMIT_EXITWINDOWS
    | JOB_OBJECT_UILIMIT_GLOBALATOMS
    | JOB_OBJECT_UILIMIT_HANDLES
    | JOB_OBJECT_UILIMIT_READCLIPBOARD
    | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
    | JOB_OBJECT_UILIMIT_WRITECLIPBOARD;

/// The reader's process and its job.
pub(crate) struct Reader {
    process: OwnedHandle,
    thread: OwnedHandle,
    /// The engine's handle to the job, the only one: the job ends the reader when it closes.
    job: OwnedHandle,
}

impl Reader {
    /// Lets the reader run, once Windows says it is in its job. Until then not one of its instructions has run.
    pub(crate) fn start(&self) -> io::Result<()> {
        let mut inside = 0;
        // SAFETY: both handles are open, and `inside` is the BOOL the call writes.
        let confined = unsafe {
            IsProcessInJob(
                self.process.as_raw_handle(),
                self.job.as_raw_handle(),
                &mut inside,
            )
        } != 0
            && inside != 0;
        // A thread created suspended has been suspended once, and by nothing else.
        // SAFETY: the thread's handle is open.
        if !confined || unsafe { ResumeThread(self.thread.as_raw_handle()) } != 1 {
            self.end();
            return Err(io::Error::other("The archive reader is not confined"));
        }
        Ok(())
    }

    /// Ends the reader. It may have ended already, which is all a failure here says.
    pub(crate) fn end(&self) {
        // SAFETY: the process's handle is open.
        unsafe { TerminateProcess(self.process.as_raw_handle(), 1) };
    }

    /// Waits for the reader to end, and gives its exit code; None where Windows cannot say.
    pub(crate) fn wait(&self) -> Option<u32> {
        let mut code = 0;
        // SAFETY: the process's handle is open, and `code` is the u32 the call writes.
        let ended = unsafe {
            WaitForSingleObject(self.process.as_raw_handle(), INFINITE) == WAIT_OBJECT_0
                && GetExitCodeProcess(self.process.as_raw_handle(), &mut code) != 0
        };
        ended.then_some(code)
    }
}

/// Creates the reader suspended, in its job, with its token, `input` as its standard input and the other two as its
/// standard output and error, which are all it inherits. The engine's copies of the three close on return.
pub(crate) fn create(
    program: &Path,
    args: &[&str],
    input: File,
    output: OwnedHandle,
    errors: OwnedHandle,
) -> io::Result<Reader> {
    let folder = program
        .parent()
        .ok_or_else(|| io::Error::other("The archive reader has no folder"))?;
    let job = job()?;
    let token = token()?;
    let given: [HANDLE; 3] = [
        input.as_raw_handle(),
        output.as_raw_handle(),
        errors.as_raw_handle(),
    ];
    // The list of handles to inherit takes only inheritable ones. No other handle of the engine's is inherited, and
    // the engine starts no other program that could take these.
    for handle in given {
        // SAFETY: each handle is open, owned by the arguments above.
        if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    let jobs = [job.as_raw_handle()];
    let mut attributes = Attributes::new(2)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &given)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    [
        startup.StartupInfo.hStdInput,
        startup.StartupInfo.hStdOutput,
        startup.StartupInfo.hStdError,
    ] = given;
    startup.lpAttributeList = attributes.list();
    let (application, mut line, environment, folder) = (
        wide(program.as_os_str()),
        command_line(program, args),
        environment(),
        wide(folder.as_os_str()),
    );
    let mut created = PROCESS_INFORMATION::default();
    // SAFETY: the strings are NUL-terminated, the environment ends with its empty string, the startup information is
    // of its own size and its list holds values that live through the call, and the token is open for assigning.
    let made = unsafe {
        CreateProcessAsUserW(
            token.as_raw_handle(),
            application.as_ptr(),
            line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED
                | DETACHED_PROCESS
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            folder.as_ptr(),
            &startup.StartupInfo,
            &mut created,
        )
    };
    if made == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: Windows opened both handles for the engine, which owns them from here.
    let (process, thread) = unsafe {
        (
            OwnedHandle::from_raw_handle(created.hProcess),
            OwnedHandle::from_raw_handle(created.hThread),
        )
    };
    Ok(Reader {
        process,
        thread,
        job,
    })
}

/// The reader's job, its limits set.
fn job() -> io::Result<OwnedHandle> {
    // SAFETY: the job's handle is checked and owned at once.
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the job's handle was just created, and nothing else owns it.
    let job = unsafe { OwnedHandle::from_raw_handle(job) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = LIMITS;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    limits.ProcessMemoryLimit = MEMORY;
    let screen = JOBOBJECT_BASIC_UI_RESTRICTIONS {
        UIRestrictionsClass: SCREEN,
    };
    // SAFETY: each structure is passed with its own size, and the job's handle is open.
    let set = unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of_val(&limits) as u32,
        ) != 0
            && SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectBasicUIRestrictions,
                (&raw const screen).cast(),
                size_of_val(&screen) as u32,
            ) != 0
    };
    if !set {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

/// The reader's token: the engine's, restricted to what the Users group and everyone may reach (the system's own
/// files), restricted code (what the reader makes itself, below) and this logon session (its desktop and named
/// objects), with no privilege but bypassing traverse checking, at low integrity.
fn token() -> io::Result<OwnedHandle> {
    let mut own = null_mut();
    // SAFETY: the pseudo-handle of this process needs no closing, and `own` receives a handle the engine owns.
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
            &mut own,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the token's handle was just opened, and nothing else owns it.
    let own = unsafe { OwnedHandle::from_raw_handle(own) };
    let (group_storage, user_storage) = (
        token_information(&own, TokenGroups)?,
        token_information(&own, TokenUser)?,
    );
    // SAFETY: Windows wrote a TOKEN_GROUPS and a TOKEN_USER there, aligned by their storage, and their SIDs point into
    // the storage, which lives to the end of this function.
    let (groups, user) = unsafe {
        let groups = &*group_storage.as_ptr().cast::<TOKEN_GROUPS>();
        (
            std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize),
            (*user_storage.as_ptr().cast::<TOKEN_USER>()).User.Sid,
        )
    };
    let logon_session = SE_GROUP_LOGON_ID as u32;
    let logon = groups
        .iter()
        .find(|group| group.Attributes & logon_session == logon_session)
        .map(|group| group.Sid);
    let (users, everyone, restricted, system, low) = (
        WellKnown::new(WinBuiltinUsersSid)?,
        WellKnown::new(WinWorldSid)?,
        WellKnown::new(WinRestrictedCodeSid)?,
        WellKnown::new(WinLocalSystemSid)?,
        WellKnown::new(WinLowLabelSid)?,
    );
    let restricting: Vec<SID_AND_ATTRIBUTES> = [users.sid(), everyone.sid(), restricted.sid()]
        .into_iter()
        .chain(logon)
        .map(|sid| SID_AND_ATTRIBUTES {
            Sid: sid,
            Attributes: 0,
        })
        .collect();
    let mut token = null_mut();
    // SAFETY: the SIDs live through the call, and `token` receives a handle the engine owns.
    if unsafe {
        CreateRestrictedToken(
            own.as_raw_handle(),
            DISABLE_MAX_PRIVILEGE,
            0,
            null(),
            0,
            null(),
            restricting.len() as u32,
            restricting.as_ptr(),
            &mut token,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the token's handle was just created, and nothing else owns it.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    // What the reader makes itself, a thread say, lets in the user, the system and restricted code, so that the reader
    // passes both checks for its own objects.
    let owners = [user, system.sid(), restricted.sid()];
    // An entry is its header and access mask, then its SID in place of SidStart.
    let entry = |sid: PSID| {
        // SAFETY: each SID is valid: the user's from the token, the others made above.
        (size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>()) as u32 + unsafe { GetLengthSid(sid) }
    };
    let length = size_of::<ACL>() as u32 + owners.iter().map(|&sid| entry(sid)).sum::<u32>();
    // u32 storage keeps the list and its entries on the 4-byte boundaries the system puts them on.
    let mut storage = vec![0u32; (length as usize).div_ceil(size_of::<u32>())];
    let list: *mut ACL = storage.as_mut_ptr().cast();
    let dacl = TOKEN_DEFAULT_DACL { DefaultDacl: list };
    let label = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: low.sid(),
            Attributes: SE_GROUP_INTEGRITY as u32,
        },
    };
    // SAFETY: the list's storage holds `length` bytes, which its entries are counted into; each structure is passed
    // with its size, the label's with its SID's; the SIDs and the list live through the calls.
    let made = unsafe {
        InitializeAcl(list, length, ACL_REVISION) != 0
            && owners
                .iter()
                .all(|&sid| AddAccessAllowedAce(list, ACL_REVISION, GENERIC_ALL, sid) != 0)
            && SetTokenInformation(
                token.as_raw_handle(),
                TokenDefaultDacl,
                (&raw const dacl).cast(),
                size_of_val(&dacl) as u32,
            ) != 0
            && SetTokenInformation(
                token.as_raw_handle(),
                TokenIntegrityLevel,
                (&raw const label).cast(),
                size_of_val(&label) as u32 + GetLengthSid(low.sid()),
            ) != 0
    };
    if !made {
        return Err(io::Error::last_os_error());
    }
    Ok(token)
}

/// What `class` says of `token`, in storage aligned for the structure Windows writes there.
fn token_information(
    token: &OwnedHandle,
    class: TOKEN_INFORMATION_CLASS,
) -> io::Result<Vec<usize>> {
    let mut length = 0;
    // SAFETY: with no buffer the call only says how long one must be.
    unsafe { GetTokenInformation(token.as_raw_handle(), class, null_mut(), 0, &mut length) };
    let mut storage = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    // SAFETY: the storage holds at least `length` bytes.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            class,
            storage.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(storage)
}

/// A SID Windows knows by name.
struct WellKnown([usize; (SECURITY_MAX_SID_SIZE as usize).div_ceil(size_of::<usize>())]);

impl WellKnown {
    fn new(kind: WELL_KNOWN_SID_TYPE) -> io::Result<Self> {
        let mut sid = Self([0; (SECURITY_MAX_SID_SIZE as usize).div_ceil(size_of::<usize>())]);
        let mut length = SECURITY_MAX_SID_SIZE;
        // SAFETY: the storage holds SECURITY_MAX_SID_SIZE bytes, the length the call is given.
        if unsafe { CreateWellKnownSid(kind, null_mut(), sid.0.as_mut_ptr().cast(), &mut length) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(sid)
    }

    fn sid(&self) -> PSID {
        self.0.as_ptr().cast_mut().cast()
    }
}

/// Attributes for creating a process, each pointing at a value that lives as long as `'a`. Deleted when dropped.
struct Attributes<'a>(Vec<usize>, PhantomData<&'a ()>);

impl<'a> Attributes<'a> {
    fn new(count: u32) -> io::Result<Self> {
        let mut size = 0;
        // SAFETY: with no list the call only says how large one must be.
        unsafe { InitializeProcThreadAttributeList(null_mut(), count, 0, &mut size) };
        let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
        // SAFETY: the storage holds at least `size` bytes.
        if unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), count, 0, &mut size)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(storage, PhantomData))
    }

    fn set<T>(&mut self, attribute: u32, value: &'a [T]) -> io::Result<()> {
        // SAFETY: the list was initialised above, and the value is passed with its size and outlives the list.
        if unsafe {
            UpdateProcThreadAttribute(
                self.list(),
                0,
                attribute as usize,
                value.as_ptr().cast(),
                size_of_val(value),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn list(&mut self) -> *mut core::ffi::c_void {
        self.0.as_mut_ptr().cast()
    }
}

impl Drop for Attributes<'_> {
    fn drop(&mut self) {
        // SAFETY: the list was initialised when it was made.
        unsafe { DeleteProcThreadAttributeList(self.list()) };
    }
}

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(iter::once(0)).collect()
}

/// `program` and `args` as one command line, each quoted the way the C runtime splits a command line again (Parsing
/// C Command-Line Arguments, in the C runtime documentation).
fn command_line(program: &Path, args: &[&str]) -> Vec<u16> {
    let (space, quote, backslash) = (u16::from(b' '), u16::from(b'"'), u16::from(b'\\'));
    let mut line = Vec::new();
    for (index, arg) in iter::once(program.as_os_str())
        .chain(args.iter().map(OsStr::new))
        .enumerate()
    {
        if index > 0 {
            line.push(space);
        }
        let units: Vec<u16> = arg.encode_wide().collect();
        if !units.is_empty()
            && !units
                .iter()
                .any(|&unit| [space, u16::from(b'\t'), quote].contains(&unit))
        {
            line.extend(units);
            continue;
        }
        // Inside quotes, backslashes are doubled before a quote of the argument and before the closing one.
        line.push(quote);
        let mut backslashes = 0;
        for unit in units {
            if unit == backslash {
                backslashes += 1;
            } else {
                if unit == quote {
                    line.extend(iter::repeat_n(backslash, backslashes + 1));
                }
                backslashes = 0;
            }
            line.push(unit);
        }
        line.extend(iter::repeat_n(backslash, backslashes));
        line.push(quote);
    }
    line.push(0);
    line
}

/// The reader's environment: the system folder's two names, which Windows' own programs read, and nothing else.
fn environment() -> Vec<u16> {
    let mut block = Vec::new();
    for name in ["SystemRoot", "windir"] {
        if let Some(value) = std::env::var_os(name) {
            block.extend(OsStr::new(name).encode_wide());
            block.push(u16::from(b'='));
            block.extend(value.encode_wide());
            block.push(0);
        }
    }
    // The block ends with an empty string: one more NUL, two where it holds nothing.
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::system_archive::{READ, reader, tests::stored_rar};
    use std::io::Read;
    use windows_sys::Win32::{
        Foundation::{INVALID_HANDLE_VALUE, LUID},
        Security::{
            GetSidSubAuthority, GetSidSubAuthorityCount, IsTokenRestricted, LookupPrivilegeValueW,
            TOKEN_PRIVILEGES, TokenPrivileges,
        },
        System::{
            IO::{CreateIoCompletionPort, GetQueuedCompletionStatus},
            JobObjects::{
                JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
                JobObjectAssociateCompletionPortInformation, JobObjectBasicAccountingInformation,
                QueryInformationJobObject,
            },
            SystemServices::{JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT, SECURITY_MANDATORY_LOW_RID},
        },
    };

    /// The reader asked to do `args` with a RAR archive of `files` as its standard input, created and not started,
    /// with its standard output and error.
    fn created(
        program: &Path,
        args: &[&str],
        files: &[(&str, &[u8])],
    ) -> (Reader, io::PipeReader, io::PipeReader) {
        let source = crate::test_dir::tempdir().unwrap();
        let path = source.path().join("study.rar");
        std::fs::write(&path, stored_rar(files)).unwrap();
        let (stream, output) = io::pipe().unwrap();
        let (complaints, errors) = io::pipe().unwrap();
        let reader = create(
            program,
            args,
            File::open(path).unwrap(),
            output.into(),
            errors.into(),
        )
        .unwrap();
        (reader, stream, complaints)
    }

    /// What the reader wrote and said, once it has ended, and its exit code.
    fn finished(
        reader: &Reader,
        mut stream: io::PipeReader,
        mut complaints: io::PipeReader,
    ) -> (Vec<u8>, String, Option<u32>) {
        std::thread::scope(|scope| {
            let said = scope.spawn(move || {
                let mut text = Vec::new();
                complaints.read_to_end(&mut text).unwrap();
                String::from_utf8_lossy(&text).into_owned()
            });
            let mut written = Vec::new();
            stream.read_to_end(&mut written).unwrap();
            (written, said.join().unwrap(), reader.wait())
        })
    }

    fn holds(bytes: &[u8], part: &[u8]) -> bool {
        bytes.windows(part.len()).any(|window| window == part)
    }

    /// What Windows says of `job` in a structure of type `T`.
    fn job_information<T: Default>(
        job: &OwnedHandle,
        class: windows_sys::Win32::System::JobObjects::JOBOBJECTINFOCLASS,
    ) -> T {
        let mut information = T::default();
        // SAFETY: the structure is passed with its own size, and the job's handle is open.
        let read = unsafe {
            QueryInformationJobObject(
                job.as_raw_handle(),
                class,
                (&raw mut information).cast(),
                size_of::<T>() as u32,
                null_mut(),
            )
        };
        assert_ne!(read, 0, "{}", io::Error::last_os_error());
        information
    }

    #[test]
    fn the_reader_is_in_its_job_with_its_token_before_its_first_instruction() {
        let Some(program) = reader() else {
            eprintln!("skipped: this system has no bsdtar");
            return;
        };
        let (reader, stream, complaints) = created(&program, READ, &[("a.dcm", b"first file")]);
        // Created, not started: in its job,
        let mut inside = 0;
        // SAFETY: both handles are open.
        unsafe {
            IsProcessInJob(
                reader.process.as_raw_handle(),
                reader.job.as_raw_handle(),
                &mut inside,
            )
        };
        assert_ne!(inside, 0);
        // which had its limits before the reader existed,
        let limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION =
            job_information(&reader.job, JobObjectExtendedLimitInformation);
        assert_eq!(limits.BasicLimitInformation.LimitFlags, LIMITS);
        assert_eq!(limits.BasicLimitInformation.ActiveProcessLimit, 1);
        assert_eq!(limits.ProcessMemoryLimit, MEMORY);
        let screen: JOBOBJECT_BASIC_UI_RESTRICTIONS =
            job_information(&reader.job, JobObjectBasicUIRestrictions);
        assert_eq!(screen.UIRestrictionsClass, SCREEN);
        // with a restricted token at low integrity, which holds no privilege but bypassing traverse checking.
        let mut token = null_mut();
        // SAFETY: the process's handle is open, and `token` receives a handle owned below.
        assert_ne!(
            unsafe { OpenProcessToken(reader.process.as_raw_handle(), TOKEN_QUERY, &mut token) },
            0
        );
        // SAFETY: the token's handle was just opened, and nothing else owns it.
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        // SAFETY: the token's handle is open.
        assert_ne!(unsafe { IsTokenRestricted(token.as_raw_handle()) }, 0);
        let label = token_information(&token, TokenIntegrityLevel).unwrap();
        // SAFETY: Windows wrote a TOKEN_MANDATORY_LABEL there, whose SID points into the storage.
        let level = unsafe {
            let sid = (*label.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()).Label.Sid;
            *GetSidSubAuthority(sid, u32::from(*GetSidSubAuthorityCount(sid)) - 1)
        };
        assert_eq!(level, SECURITY_MANDATORY_LOW_RID as u32);
        let mut traverse = LUID::default();
        let name = wide(OsStr::new("SeChangeNotifyPrivilege"));
        // SAFETY: the name is NUL-terminated, and `traverse` is the LUID the call writes.
        assert_ne!(
            unsafe { LookupPrivilegeValueW(null(), name.as_ptr(), &mut traverse) },
            0
        );
        let privileges = token_information(&token, TokenPrivileges).unwrap();
        // SAFETY: Windows wrote a TOKEN_PRIVILEGES there, with its count of entries after it.
        let privileges = unsafe {
            let held = &*privileges.as_ptr().cast::<TOKEN_PRIVILEGES>();
            std::slice::from_raw_parts(held.Privileges.as_ptr(), held.PrivilegeCount as usize)
        };
        assert!(
            privileges.iter().all(
                |privilege| (privilege.Luid.LowPart, privilege.Luid.HighPart)
                    == (traverse.LowPart, traverse.HighPart)
            ),
            "{} privileges",
            privileges.len()
        );
        // Its thread had been suspended once and run no instruction: start resumes it from there.
        reader.start().unwrap();
        let (written, _, code) = finished(&reader, stream, complaints);
        assert_eq!(code, Some(0));
        assert!(holds(&written, b"first file"));
    }

    #[test]
    fn a_program_the_reader_starts_is_refused_by_its_job() {
        let Some(program) = reader() else {
            eprintln!("skipped: this system has no bsdtar");
            return;
        };
        // bsdtar starts the program it is given to compress what it writes: here a second copy of itself.
        let args = ["-cf", "-", "--use-compress-program=tar.exe", "@-"];
        let (reader, stream, complaints) = created(&program, &args, &[("a.dcm", b"first file")]);
        // A port the job reports to, set while the reader is still suspended.
        // SAFETY: a new port, checked and owned at once.
        let port = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1) };
        assert!(!port.is_null());
        // SAFETY: the port was just created, and nothing else owns it.
        let port = unsafe { OwnedHandle::from_raw_handle(port) };
        let reports = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: null_mut(),
            CompletionPort: port.as_raw_handle(),
        };
        // SAFETY: the structure is passed with its own size, and both handles are open.
        let set = unsafe {
            SetInformationJobObject(
                reader.job.as_raw_handle(),
                JobObjectAssociateCompletionPortInformation,
                (&raw const reports).cast(),
                size_of_val(&reports) as u32,
            )
        };
        assert_ne!(set, 0);
        reader.start().unwrap();
        let (written, said, code) = finished(&reader, stream, complaints);
        assert_ne!(code, Some(0));
        assert!(written.is_empty());
        assert!(said.contains("tar.exe"), "{said}");
        // The job refused the program: Windows reported its one process to be taken.
        let mut messages = Vec::new();
        loop {
            let (mut message, mut key, mut overlapped) = (0, 0, null_mut());
            // SAFETY: the port's handle is open, and each output is the type the call writes.
            if unsafe {
                GetQueuedCompletionStatus(
                    port.as_raw_handle(),
                    &mut message,
                    &mut key,
                    &mut overlapped,
                    0,
                )
            } == 0
            {
                break;
            }
            messages.push(message);
        }
        assert!(
            messages.contains(&JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT),
            "{messages:?}"
        );
        let accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION =
            job_information(&reader.job, JobObjectBasicAccountingInformation);
        assert_eq!(accounting.TotalProcesses, 1);
    }

    #[test]
    fn the_reader_can_neither_read_nor_write_a_folder_of_this_users_own() {
        let Some(program) = reader() else {
            eprintln!("skipped: this system has no bsdtar");
            return;
        };
        // An import's extraction folder lets in the user and the system alone (archive_temp.rs).
        let private = crate::archive_temp::create("veacom-import-").unwrap();
        let own = private.path().join("own.dcm");
        std::fs::write(&own, b"a file of this user's").unwrap();
        let run = |args: &[&str]| {
            let (reader, stream, complaints) = created(&program, args, &[("a.dcm", b"first file")]);
            reader.start().unwrap();
            finished(&reader, stream, complaints)
        };
        // Asked for the user's file by its name, the reader cannot open it,
        let (written, said, code) = run(&["-cf", "-", own.to_str().unwrap()]);
        assert_ne!(code, Some(0), "{said}");
        assert!(!holds(&written, b"a file of this user's"));
        // while a file every user may read, its own program, is handed over: what kept the first out is its token.
        let (written, said, code) = run(&["-cf", "-", program.to_str().unwrap()]);
        assert_eq!(code, Some(0), "{said}");
        assert!(holds(&written, b"tar.exe"));
        // Asked to write the archive's files into the folder, it writes nothing there.
        let (_, said, code) = run(&["-xf", "-", "-C", private.path().to_str().unwrap()]);
        assert_ne!(code, Some(0), "{said}");
        assert!(!private.path().join("a.dcm").exists());
        assert_eq!(std::fs::read(&own).unwrap(), b"a file of this user's");
    }

    #[test]
    fn each_argument_is_quoted_as_the_c_runtime_reads_it() {
        let line = command_line(
            Path::new(r"C:\Windows\System32\tar.exe"),
            &[
                "-cf",
                "-",
                "a b",
                "",
                r#"say "hi""#,
                r"C:\with space\",
                r"back\\slash",
            ],
        );
        let text = String::from_utf16(&line[..line.len() - 1]).unwrap();
        assert_eq!(
            text,
            r#"C:\Windows\System32\tar.exe -cf - "a b" "" "say \"hi\"" "C:\with space\\" back\\slash"#
        );
    }
}
