// CH4C service launcher.
//
// Installed and compiled by `ch4c service install`. This program is the
// process the WinSW service runs: it executes as LocalSystem in session 0,
// where Chrome cannot run. Its only job is to spawn CH4C inside the
// interactive user's session using that user's de-elevated (UAC-filtered)
// token, so Chrome launches normally and CH4C's own "administrator mode"
// guard is satisfied.
//
// It keeps CH4C running: if CH4C exits, or no user is logged on yet, it
// retries until a user session is available. The child is placed in a job
// object so it is killed if this launcher (and therefore the service) stops.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Ch4cLauncher
{
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_SUSPENDED           = 0x00000004;
    private const uint CREATE_NO_WINDOW           = 0x08000000;
    private const uint INFINITE                   = 0xFFFFFFFF;
    private const uint INVALID_SESSION            = 0xFFFFFFFF;
    private const uint MAXIMUM_ALLOWED            = 0x02000000;
    private const int  TokenPrimary               = 1;
    private const int  SecurityImpersonation      = 2;
    private const int  JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int  RETRY_DELAY_MS             = 5000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize;
        public int dwXCountChars, dwYCountChars, dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll")]
    private static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(IntPtr hExistingToken, uint dwDesiredAccess,
        IntPtr lpTokenAttributes, int impersonationLevel, int tokenType, out IntPtr phNewToken);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(IntPtr hToken, string lpApplicationName,
        StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass,
        IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private static void Log(string message)
    {
        Console.WriteLine("[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + message);
    }

    private static string Quote(string value)
    {
        return value.IndexOf(' ') >= 0 ? "\"" + value + "\"" : value;
    }

    // A job object that kills every process inside it once the last handle
    // closes. Holding the handle for the life of the launcher means CH4C is
    // terminated when the service stops.
    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;

        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(length);
        Marshal.StructureToPtr(info, ptr, false);
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)length);
        Marshal.FreeHGlobal(ptr);
        return job;
    }

    // Spawns CH4C in the active console session and blocks until it exits.
    private static void RunOnce(string exePath, string commandLine, string workingDir, IntPtr job)
    {
        uint sessionId = WTSGetActiveConsoleSessionId();
        if (sessionId == INVALID_SESSION)
            throw new Exception("No interactive user session is currently attached.");

        IntPtr userToken;
        if (!WTSQueryUserToken(sessionId, out userToken))
            throw new Exception("No user is logged on to session " + sessionId +
                " (WTSQueryUserToken error " + Marshal.GetLastWin32Error() + ").");

        IntPtr primaryToken = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        try
        {
            if (!DuplicateTokenEx(userToken, MAXIMUM_ALLOWED, IntPtr.Zero,
                    SecurityImpersonation, TokenPrimary, out primaryToken))
                throw new Exception("DuplicateTokenEx failed (error " +
                    Marshal.GetLastWin32Error() + ").");

            if (!CreateEnvironmentBlock(out environment, primaryToken, false))
                environment = IntPtr.Zero; // fall back to the default environment

            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            si.lpDesktop = "winsta0\\default";

            PROCESS_INFORMATION pi;
            StringBuilder cmd = new StringBuilder(commandLine);
            uint flags = CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED | CREATE_NO_WINDOW;

            if (!CreateProcessAsUser(primaryToken, exePath, cmd, IntPtr.Zero, IntPtr.Zero,
                    false, flags, environment, workingDir, ref si, out pi))
                throw new Exception("CreateProcessAsUser failed (error " +
                    Marshal.GetLastWin32Error() + ").");

            AssignProcessToJobObject(job, pi.hProcess);
            ResumeThread(pi.hThread);
            CloseHandle(pi.hThread);

            Log("CH4C started in session " + sessionId + " (pid " + pi.dwProcessId + ").");
            WaitForSingleObject(pi.hProcess, INFINITE);
            Log("CH4C exited.");
            CloseHandle(pi.hProcess);
        }
        finally
        {
            if (environment != IntPtr.Zero) DestroyEnvironmentBlock(environment);
            if (primaryToken != IntPtr.Zero) CloseHandle(primaryToken);
            CloseHandle(userToken);
        }
    }

    private static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("Usage: ch4c-launcher <ch4c-executable> [args...]");
            return 1;
        }

        string exePath = args[0];
        StringBuilder builder = new StringBuilder(Quote(exePath));
        for (int i = 1; i < args.Length; i++)
            builder.Append(' ').Append(Quote(args[i]));
        string commandLine = builder.ToString();

        // WinSW sets this process's working directory from <workingdirectory>;
        // CH4C inherits the same directory.
        string workingDir = Directory.GetCurrentDirectory();

        IntPtr job = CreateKillOnCloseJob();
        if (job == IntPtr.Zero)
        {
            Console.Error.WriteLine("Failed to create job object; aborting.");
            return 1;
        }

        Log("CH4C launcher started. Target: " + commandLine);
        while (true)
        {
            try
            {
                RunOnce(exePath, commandLine, workingDir, job);
            }
            catch (Exception ex)
            {
                Log(ex.Message);
            }
            Thread.Sleep(RETRY_DELAY_MS);
        }
    }
}
