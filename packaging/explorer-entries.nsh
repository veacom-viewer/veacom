; Explorer entries for VEAcom: written by the Windows installer and removed by its uninstaller
; (electron-builder.release.cjs, nsis.include). They sit under Software\Classes of the install's own scope: the
; current user for a per-user install, the machine for an all-users one.
;
;   folder, drive     right-click, "Open with VEAcom"
;   ZIP file          right-click, "Open with VEAcom", whatever program owns .zip
;   DICOMDIR file     right-click, "Open with VEAcom": the disc it indexes opens
;   .dcm file         VEAcom is listed under "Open with"; the default program stays as it is
;
; Each runs the installed program with --study and the path. A VEAcom that is running takes the study over
; (electron/launch-paths.cjs). A drive's path ends in a backslash, which would escape the closing quote of its
; argument: the drive's command adds a dot, so E:\. is passed and read as E:\.
;
; tools/check-windows-package.ps1 checks the entries after a silent install and their removal after an uninstall.

!define VEACOM_VERB "VEAcom"
!define VEACOM_PROGID "VEAcom.dcm"
!ifndef VEACOM_CLASSES
  !define VEACOM_CLASSES "Software\Classes"
!endif

; One "Open with VEAcom" entry: its words are in $R8.
!macro veacomVerb KEY ARGUMENT
  WriteRegStr SHELL_CONTEXT "${VEACOM_CLASSES}\${KEY}\shell\${VEACOM_VERB}" "" "$R8"
  WriteRegStr SHELL_CONTEXT "${VEACOM_CLASSES}\${KEY}\shell\${VEACOM_VERB}" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr SHELL_CONTEXT "${VEACOM_CLASSES}\${KEY}\shell\${VEACOM_VERB}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --study "${ARGUMENT}"'
!macroend

; An entry and the keys above it that it leaves empty. Keys other programs use are never empty, so they stay.
!macro veacomRemoveVerb KEY
  DeleteRegKey SHELL_CONTEXT "${VEACOM_CLASSES}\${KEY}\shell\${VEACOM_VERB}"
  DeleteRegKey /ifempty SHELL_CONTEXT "${VEACOM_CLASSES}\${KEY}\shell"
  DeleteRegKey /ifempty SHELL_CONTEXT "${VEACOM_CLASSES}\${KEY}"
!macroend

!macro customInstall
  Push $R8
  Push $R9
  ; The words follow the language Windows is shown in: Turkish, or English for every other language.
  System::Call 'kernel32::GetUserDefaultUILanguage() i .R9'
  IntOp $R9 $R9 & 0x3FF
  ${If} $R9 = 0x1F
    StrCpy $R8 "VEAcom ile aç"
  ${Else}
    StrCpy $R8 "Open with VEAcom"
  ${EndIf}
  !insertmacro veacomVerb "Directory" "%1"
  !insertmacro veacomVerb "Drive" "%1."
  !insertmacro veacomVerb "SystemFileAssociations\.zip" "%1"
  !insertmacro veacomVerb "*" "%1"
  WriteRegStr SHELL_CONTEXT "${VEACOM_CLASSES}\*\shell\${VEACOM_VERB}" "AppliesTo" 'System.FileName:="DICOMDIR"'
  ; A .dcm file lists VEAcom under "Open with". The extension's own default value is not written.
  WriteRegNone SHELL_CONTEXT "${VEACOM_CLASSES}\.dcm\OpenWithProgids" "${VEACOM_PROGID}"
  ${If} $R9 = 0x1F
    WriteRegStr SHELL_CONTEXT "${VEACOM_CLASSES}\${VEACOM_PROGID}" "" "DICOM görüntüsü"
  ${Else}
    WriteRegStr SHELL_CONTEXT "${VEACOM_CLASSES}\${VEACOM_PROGID}" "" "DICOM image"
  ${EndIf}
  WriteRegStr SHELL_CONTEXT "${VEACOM_CLASSES}\${VEACOM_PROGID}\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHELL_CONTEXT "${VEACOM_CLASSES}\${VEACOM_PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --study "%1"'
  ; Explorer reads the entries again (SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  Pop $R9
  Pop $R8
!macroend

!macro customUnInstall
  !insertmacro veacomRemoveVerb "Directory"
  !insertmacro veacomRemoveVerb "Drive"
  !insertmacro veacomRemoveVerb "SystemFileAssociations\.zip"
  DeleteRegKey /ifempty SHELL_CONTEXT "${VEACOM_CLASSES}\SystemFileAssociations"
  !insertmacro veacomRemoveVerb "*"
  DeleteRegValue SHELL_CONTEXT "${VEACOM_CLASSES}\.dcm\OpenWithProgids" "${VEACOM_PROGID}"
  DeleteRegKey /ifempty SHELL_CONTEXT "${VEACOM_CLASSES}\.dcm\OpenWithProgids"
  DeleteRegKey /ifempty SHELL_CONTEXT "${VEACOM_CLASSES}\.dcm"
  DeleteRegKey SHELL_CONTEXT "${VEACOM_CLASSES}\${VEACOM_PROGID}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
