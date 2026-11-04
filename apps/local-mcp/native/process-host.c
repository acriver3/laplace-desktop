#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
#include <stdlib.h>

// CRT argv -> CreateProcessW quoting. Backslashes before quotes and at the end
// must be doubled; executable paths and arguments never enter a shell.
static wchar_t *quote(wchar_t *out, const wchar_t *arg) {
    *out++ = L'"';
    while (*arg) {
        unsigned slashes = 0;
        while (*arg == L'\\') { ++slashes; ++arg; }
        unsigned count = (*arg == L'"' || !*arg) ? slashes * 2 : slashes;
        while (count--) *out++ = L'\\';
        if (*arg == L'"') *out++ = L'\\';
        if (*arg) *out++ = *arg++;
    }
    *out++ = L'"';
    return out;
}
int wmain(int argc, wchar_t **argv) {
    if (argc < 3) return 1;
    size_t length = 1;
    for (int i = 2; i < argc; ++i) length += wcslen(argv[i]) * 2 + 4;
    wchar_t *command = calloc(length, sizeof(wchar_t));
    if (!command) return 1;
    wchar_t *p = command;
    for (int i = 2; i < argc; ++i) { if (i > 2) *p++ = L' '; p = quote(p, argv[i]); } *p = 0;
    HANDLE job = CreateJobObjectW(NULL, NULL);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 1;
    STARTUPINFOW startup = {0}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE); startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE); startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION process = {0};
    if (!CreateProcessW(NULL, command, NULL, NULL, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL, &startup, &process)) return 1;
    free(command);
    if (!AssignProcessToJobObject(job, process.hProcess)) { TerminateProcess(process.hProcess, 1); CloseHandle(job); return 1; }
    ResumeThread(process.hThread); CloseHandle(process.hThread);
    // Parent death must close the job even when the upstream server remains alive.
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)_wtoi(argv[1]));
    if (!parent) { CloseHandle(job); CloseHandle(process.hProcess); return 1; }
    HANDLE waits[2] = { process.hProcess, parent };
    WaitForMultipleObjects(2, waits, FALSE, INFINITE);
    CloseHandle(parent);
    DWORD code = 1; GetExitCodeProcess(process.hProcess, &code); CloseHandle(process.hProcess); CloseHandle(job);
    return (int)code;
}
