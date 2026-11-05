// Packdeck native process helper.
//
//   packdeck-procs.exe processes [--filter <a,b,c>] [--wmi 0|1] [--cache <file>]
//   packdeck-procs.exe detail <pid> [<pid> ...]
//   packdeck-procs.exe kill <pid>
//
// Built with the Windows-bundled C# 5 compiler (.NET Framework 4.8):
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /codepage:65001 /optimize+
//     /platform:anycpu /target:exe /r:System.Management.dll
// See native/build.ps1 and lib/procs.js (which compiles on demand and degrades gracefully).
//
// Contract for every subcommand: exactly ONE UTF-8 JSON document on stdout; diagnostics never
// carry environment values or command lines; failures print {"error":{"code","message"}} and
// exit non-zero.
//
// Why a native helper: PowerShell start-up alone costs ~650 ms on the reference machine, far
// outside the Packdeck refresh budget. Process.GetProcesses() + the .NET per-process properties
// take ~16 ms for the whole table, so only the command lines are expensive (they need WMI,
// ~230-270 ms for a class materialisation). Command lines are therefore fetched for candidate
// processes only and cached on disk per pid + image start time.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;

namespace Packdeck
{
    internal static class Program
    {
        private const long CacheTtlSeconds = 900;
        private static readonly StringBuilder Out = new StringBuilder(256 * 1024);
        private static long _epochBase;

        /// <summary>Image names whose command lines the binder needs (interpreters, managers, editors).</summary>
        private static readonly HashSet<string> DefaultFilter = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "node", "nodejs", "bun", "deno", "electron",
            "python", "pythonw", "python3", "pip", "pip3", "uv", "uvx",
            "cargo", "rustc", "rustup", "node-gyp", "go", "gopls",
            "ruby", "gem", "bundle", "irb", "dotnet",
            "npm", "npx", "pnpm", "yarn", "corepack",
            "cmd", "powershell", "pwsh", "conhost", "wt", "WindowsTerminal",
            "code", "PinK", "pink", "cursor", "windsurf",
        };

        private static int Main(string[] args)
        {
            try
            {
                Console.OutputEncoding = new UTF8Encoding(false);
            }
            catch (Exception)
            {
                // redirected stdout keeps its own encoding
            }
            _epochBase = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).ToFileTimeUtc();

            if (args.Length == 0)
            {
                return Fail("bad-request", "缺少子命令（processes | detail | kill）", 2);
            }

            try
            {
                switch (args[0].ToLowerInvariant())
                {
                    case "processes": return Processes(args);
                    case "detail": return Detail(args);
                    case "kill": return Kill(args);
                    default: return Fail("bad-request", "未知的子命令：" + args[0], 2);
                }
            }
            catch (Exception error)
            {
                return Fail("internal", error.GetType().Name + ": " + error.Message, 1);
            }
        }

        /* ============================================================= processes */

        private static int Processes(string[] args)
        {
            Stopwatch total = Stopwatch.StartNew();
            Stopwatch enumWatch = new Stopwatch();
            Stopwatch propsWatch = new Stopwatch();
            Stopwatch wmiWatch = new Stopwatch();
            Stopwatch ioWatch = new Stopwatch();
            int wmiPending = 0;

            HashSet<string> filter = DefaultFilter;
            bool allowWmi = true;
            string wmiMode = "wait";
            string cachePath = null;
            for (int index = 1; index < args.Length; index++)
            {
                if (args[index] == "--filter" && index + 1 < args.Length) filter = SplitNames(args[++index]);
                else if (args[index] == "--wmi" && index + 1 < args.Length)
                {
                    string mode = args[++index].ToLowerInvariant();
                    allowWmi = mode != "0" && mode != "off";
                    wmiMode = mode;
                }
                else if (args[index] == "--all" ) allowWmi = false;
                else if (args[index] == "--cache" && index + 1 < args.Length) cachePath = args[++index];
            }

            enumWatch.Start();
            Process[] running = Process.GetProcesses();
            enumWatch.Stop();

            int count = running.Length;
            int[] ids = new int[count];
            string[] names = new string[count];
            long[] rss = new long[count];
            long[] cpu = new long[count];
            long[] started = new long[count];
            int[] sessions = new int[count];
            List<int> candidates = new List<int>(256);
            Dictionary<int, long> starts = new Dictionary<int, long>(count);

            propsWatch.Start();
            for (int index = 0; index < count; index++)
            {
                Process process = running[index];
                int pid;
                try { pid = process.Id; }
                catch (Exception) { process.Dispose(); continue; }

                string name = null;
                try { name = process.ProcessName; } catch (Exception) { name = null; }
                long workingSet;
                try { workingSet = process.WorkingSet64; } catch (Exception) { workingSet = 0; }
                long processorTicks;
                try { processorTicks = (long)(process.TotalProcessorTime.TotalMilliseconds * 10000.0); } catch (Exception) { processorTicks = 0; }
                long startMicro;
                try { startMicro = ToEpochMicro(process.StartTime.ToUniversalTime()); } catch (Exception) { startMicro = 0; }
                int session;
                try { session = process.SessionId; } catch (Exception) { session = 0; }
                process.Dispose();

                ids[index] = pid;
                names[index] = name ?? string.Empty;
                rss[index] = workingSet;
                cpu[index] = processorTicks;
                started[index] = startMicro;
                sessions[index] = session;
                if (pid > 0 && name != null)
                {
                    starts[pid] = startMicro;
                    if (filter.Contains(name)) candidates.Add(pid);
                }
            }
            propsWatch.Stop();

            Dictionary<int, Win32Row> rows = new Dictionary<int, Win32Row>(candidates.Count);
            ioWatch.Start();
            Dictionary<int, Win32Row> cache = cachePath == null
                ? new Dictionary<int, Win32Row>()
                : WmiCache.Load(cachePath);
            ioWatch.Stop();
            double nowSeconds = DateTime.UtcNow.Subtract(new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds;

            List<int> missing = new List<int>(candidates.Count);
            foreach (int pid in candidates)
            {
                Win32Row cached;
                long startMicro;
                starts.TryGetValue(pid, out startMicro);
                if (cache.TryGetValue(pid, out cached) && Fresh(cached, startMicro, nowSeconds)) rows[pid] = cached;
                else missing.Add(pid);
            }

            // WMI is the only expensive stage (~230-270 ms, independent of pid count). In `wait`
            // mode it runs inline and every candidate ships with its command line. In `async`
            // mode the payload is emitted first (so the caller pays only the ~18 ms .NET cost)
            // and the command lines are fetched afterwards, before the process exits, purely to
            // refill the on-disk cache for the next refresh.
            wmiPending = 0;
            wmiWatch.Start();
            if (allowWmi && missing.Count > 0 && wmiMode == "wait")
            {
                CollectCommandLines(missing, rows, nowSeconds);
            }
            wmiWatch.Stop();

            // Payload: every process is listed so totals stay honest, but only candidate rows carry
            // `exe`, `cmdline` and the process metadata the binder uses.
            Out.Length = 0;
            Out.Append("{\"processes\":[");
            HashSet<int> candidateSet = new HashSet<int>(candidates);
            bool firstRow = true;
            int withCmdline = 0;
            for (int index = 0; index < count; index++)
            {
                int pid = ids[index];
                if (pid <= 0) continue;
                Win32Row row;
                rows.TryGetValue(pid, out row);
                bool rich = candidateSet.Contains(pid);
                if (!firstRow) Out.Append(',');
                firstRow = false;
                Out.Append("{\"pid\":").Append(pid)
                   .Append(",\"name\":").Append(Quote(names[index]));
                if (rich)
                {
                    if (row != null && row.ParentPid > 0) Out.Append(",\"ppid\":").Append(row.ParentPid);
                    if (row != null && !string.IsNullOrEmpty(row.ExecutablePath)) Out.Append(",\"exe\":").Append(Quote(row.ExecutablePath));
                    if (row != null && !string.IsNullOrEmpty(row.CommandLine))
                    {
                        withCmdline += 1;
                        Out.Append(",\"cmdline\":").Append(Quote(row.CommandLine));
                    }
                    Out.Append(",\"rssBytes\":").Append(rss[index])
                       .Append(",\"cpuTicks\":").Append(cpu[index]);
                    if (started[index] > 0) Out.Append(",\"startedAt\":").Append(started[index] / 1000L);
                    if (sessions[index] != 0) Out.Append(",\"session\":").Append(sessions[index]);
                    Out.Append(",\"candidate\":true");
                }
                Out.Append('}');
            }
            total.Stop();
            Out.Append("],\"totals\":{\"processes\":").Append(count)
               .Append(",\"candidates\":").Append(candidates.Count)
               .Append(",\"withCmdline\":").Append(withCmdline)
               .Append(",\"wmi\":").Append(allowWmi ? 1 : 0)
               .Append(",\"cpus\":").Append(Environment.ProcessorCount)
               .Append("},\"timings\":{\"enum\":").Append(enumWatch.ElapsedMilliseconds)
               .Append(",\"props\":").Append(propsWatch.ElapsedMilliseconds)
               .Append(",\"wmi\":").Append(wmiWatch.ElapsedMilliseconds)
               .Append(",\"io\":").Append(ioWatch.ElapsedMilliseconds)
               .Append(",\"total\":").Append(total.ElapsedMilliseconds).Append("}}");
            Emit(Out.ToString());

            // Async mode: the payload is already on stdout, so stdout latency is unaffected. Only
            // a handful of new pids are worth a WMI round trip; when almost everything is cached
            // the file is simply rewritten. Both steps are skipped beyond a small batch so a
            // pathological churn cannot keep the process alive.
            if (allowWmi && missing.Count > 0 && wmiMode != "wait")
            {
                // stdout is already flushed, so this fill costs the caller nothing; it exists so
                // the NEXT refresh binds on command lines instead of executable paths alone.
                CollectCommandLines(missing, rows, nowSeconds);
                PersistCache(cachePath, starts, rows, nowSeconds);
            }
            else if (cachePath != null)
            {
                PersistCache(cachePath, starts, rows, nowSeconds);
            }
            return 0;
        }

        private static bool Fresh(Win32Row row, long startMicro, double nowSeconds)
        {
            if (Math.Abs(nowSeconds - row.At) > CacheTtlSeconds) return false;
            if (startMicro <= 0 || row.StartMicro <= 0) return true;
            return Math.Abs(row.StartMicro - startMicro) < 2000000L;
        }

        /// <summary>Command lines for the pids the cache does not cover (the WMI stage).</summary>
        private static void CollectCommandLines(List<int> pids, Dictionary<int, Win32Row> into, double nowSeconds)
        {
            if (pids == null || pids.Count == 0) return;
            try
            {
                foreach (Win32Row row in Win32Query.ForPids(pids))
                {
                    row.At = nowSeconds;
                    lock (into) into[row.Pid] = row;
                }
            }
            catch (Exception)
            {
                // WMI unavailable: the caller still gets the .NET table and binds on names.
            }
        }

        /// <summary>Rewrite the cache with only the rows that still describe a live process.</summary>
        private static void PersistCache(string cachePath, Dictionary<int, long> starts, Dictionary<int, Win32Row> rows, double nowSeconds)
        {
            if (cachePath == null) return;
            try
            {
                Dictionary<int, Win32Row> keep = new Dictionary<int, Win32Row>(rows.Count);
                lock (rows)
                {
                    foreach (int pid in starts.Keys)
                    {
                        Win32Row row;
                        if (rows.TryGetValue(pid, out row) && Fresh(row, starts[pid], nowSeconds)) keep[pid] = row;
                    }
                }
                WmiCache.Save(cachePath, keep);
            }
            catch (Exception)
            {
                // a read-only data directory only costs the next refresh
            }
        }

        private static HashSet<string> SplitNames(string value)
        {
            HashSet<string> set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string part in value.Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string name = part.Trim();
                if (name.Length == 0) continue;
                if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);
                set.Add(name);
            }
            return set;
        }

        /* ================================================================ detail */

        private static int Detail(string[] args)
        {
            Stopwatch total = Stopwatch.StartNew();
            Stopwatch wmiWatch = new Stopwatch();
            Stopwatch pebWatch = new Stopwatch();

            List<int> pids = new List<int>();
            for (int index = 1; index < args.Length; index++)
            {
                int pid;
                if (args[index] == "--cache")
                {
                    index += 1;
                    continue;
                }
                if (!int.TryParse(args[index], NumberStyles.Integer, CultureInfo.InvariantCulture, out pid) || pid <= 0)
                {
                    return Fail("bad-request", "pid 不合法：" + args[index], 2);
                }
                pids.Add(pid);
            }
            if (pids.Count == 0) return Fail("bad-request", "缺少 pid", 2);
            if (pids.Count > 64) return Fail("bad-request", "一次最多 64 个 pid", 2);

            // cmdline/exe come from the shared on-disk cache first (the `processes` path
            // fills it); WMI is only queried for the pids the cache does not know.
            string cachePath = null;
            for (int index = 1; index < args.Length; index++)
            {
                if (args[index] == "--cache" && index + 1 < args.Length) cachePath = args[++index];
            }
            wmiWatch.Start();
            Dictionary<int, Win32Row> rows = new Dictionary<int, Win32Row>();
            Dictionary<int, Win32Row> cached = cachePath == null ? new Dictionary<int, Win32Row>() : WmiCache.Load(cachePath);
            List<int> unresolved = new List<int>(pids.Count);
            foreach (int pid in pids)
            {
                Win32Row row;
                if (cached.TryGetValue(pid, out row)) rows[pid] = row;
                else unresolved.Add(pid);
            }
            if (unresolved.Count > 0)
            {
                try
                {
                    foreach (Win32Row row in Win32Query.ForPids(unresolved)) rows[row.Pid] = row;
                }
                catch (Exception)
                {
                    // command lines are optional: the rest of the detail is unaffected
                }
            }
            // Children are derived from the rows we already have (each row carries its parent),
            // so a fully cached detail never touches WMI at all.
            Dictionary<int, List<int>> children = new Dictionary<int, List<int>>();
            foreach (Win32Row row in rows.Values)
            {
                if (row.ParentPid <= 0) continue;
                List<int> list;
                if (!children.TryGetValue(row.ParentPid, out list))
                {
                    list = new List<int>(4);
                    children[row.ParentPid] = list;
                }
                list.Add(row.Pid);
            }
            wmiWatch.Stop();

            Out.Length = 0;
            Out.Append("{\"processes\":[");
            bool first = true;
            foreach (int pid in pids)
            {
                Process process;
                try
                {
                    process = Process.GetProcessById(pid);
                }
                catch (ArgumentException)
                {
                    continue;
                }

                Win32Row row;
                rows.TryGetValue(pid, out row);
                if (!first) Out.Append(',');
                first = false;

                long workingSet = 0;
                long processorTicks = 0;
                long startedAt = 0;
                int threads = 0;
                string status = null;
                try { workingSet = process.WorkingSet64; } catch (Exception) { workingSet = 0; }
                try { processorTicks = (long)(process.TotalProcessorTime.TotalMilliseconds * 10000.0); } catch (Exception) { processorTicks = 0; }
                try { startedAt = ToEpochMicro(process.StartTime.ToUniversalTime()); } catch (Exception) { startedAt = 0; }
                try { threads = process.Threads.Count; } catch (Exception) { threads = 0; }
                try { status = process.HasExited ? "exited" : (process.Responding ? "running" : "not-responding"); }
                catch (Exception) { status = null; }
                process.Dispose();

                pebWatch.Start();
                string cwd = null;
                Dictionary<string, string> environment = null;
                string envError = null;
                string envCode = null;
                try
                {
                    using (RemoteMemory memory = RemoteMemory.Open(pid))
                    {
                        if (memory == null)
                        {
                            envError = "拒绝访问";
                            envCode = "access-denied";
                        }
                        else
                        {
                            string cwdCode;
                            cwd = memory.WorkingDirectory(out cwdCode);
                            environment = memory.Environment();
                            if (environment == null)
                            {
                                envCode = memory.LastErrorCode ?? "unsupported";
                                envError = envCode == "access-denied" ? "拒绝访问" : "无法读取环境变量";
                            }
                        }
                    }
                }
                catch (Exception error)
                {
                    environment = null;
                    envCode = error is UnauthorizedAccessException ? "access-denied" : "unsupported";
                    envError = envCode == "access-denied" ? "拒绝访问" : "无法读取进程内存";
                }
                pebWatch.Stop();

                List<int> kids;
                children.TryGetValue(pid, out kids);

                Out.Append("{\"pid\":").Append(pid);
                if (row != null && row.ParentPid > 0) Out.Append(",\"ppid\":").Append(row.ParentPid);
                Out.Append(",\"name\":").Append(Quote(row != null ? row.Name : SafeName(pid)));
                if (row != null && !string.IsNullOrEmpty(row.ExecutablePath)) Out.Append(",\"exe\":").Append(Quote(row.ExecutablePath));
                if (row != null && !string.IsNullOrEmpty(row.CommandLine)) Out.Append(",\"cmdline\":").Append(Quote(row.CommandLine));
                if (cwd != null) Out.Append(",\"cwd\":").Append(Quote(cwd));
                if (row != null && !string.IsNullOrEmpty(row.Owner)) Out.Append(",\"user\":").Append(Quote(row.Owner));
                Out.Append(",\"threads\":").Append(threads);
                if (status != null) Out.Append(",\"status\":").Append(Quote(status));
                Out.Append(",\"rssBytes\":").Append(workingSet)
                   .Append(",\"cpuTicks\":").Append(processorTicks);
                if (startedAt > 0) Out.Append(",\"startedAt\":").Append(startedAt / 1000L);
                Out.Append(",\"env\":");
                if (environment == null)
                {
                    Out.Append("null");
                }
                else
                {
                    Out.Append('{');
                    bool firstVariable = true;
                    foreach (KeyValuePair<string, string> pair in environment)
                    {
                        if (!firstVariable) Out.Append(',');
                        firstVariable = false;
                        Out.Append(Quote(pair.Key)).Append(':').Append(Quote(pair.Value));
                    }
                    Out.Append('}');
                }
                Out.Append(",\"envCount\":").Append(environment == null ? 0 : environment.Count)
                   .Append(",\"envError\":").Append(Quote(envError))
                   .Append(",\"envCode\":").Append(Quote(envCode))
                   .Append(",\"children\":[");
                if (kids != null)
                {
                    for (int index = 0; index < kids.Count; index++)
                    {
                        if (index > 0) Out.Append(',');
                        Out.Append(kids[index]);
                    }
                }
                Out.Append("]}");
            }
            total.Stop();
            Out.Append("],\"timings\":{\"wmi\":").Append(wmiWatch.ElapsedMilliseconds)
               .Append(",\"peb\":").Append(pebWatch.ElapsedMilliseconds)
               .Append(",\"total\":").Append(total.ElapsedMilliseconds).Append("}}");
            Emit(Out.ToString());
            return 0;
        }

        private static string SafeName(int pid)
        {
            try
            {
                using (Process process = Process.GetProcessById(pid))
                {
                    return process.ProcessName;
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        /* ================================================================== kill */

        private static int Kill(string[] args)
        {
            if (args.Length < 2) return Fail("bad-request", "缺少 pid", 2);
            if (args.Length > 2) return Fail("bad-request", "kill 只接受一个 pid", 2);
            int pid;
            if (!int.TryParse(args[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out pid) || pid <= 0)
            {
                return Fail("bad-request", "pid 不合法：" + args[1], 2);
            }
            if (pid == Process.GetCurrentProcess().Id) return Fail("bad-request", "不能结束自身进程", 2);

            IntPtr handle = Native.OpenProcess(Native.PROCESS_TERMINATE, false, pid);
            if (handle == IntPtr.Zero)
            {
                int code = Marshal.GetLastWin32Error();
                return Fail(code == 5 ? "access-denied" : "command-failed", "无法打开进程 " + pid + "（Win32 错误 " + code + "）", 3);
            }
            bool ok;
            try
            {
                ok = Native.TerminateProcess(handle, 1);
            }
            finally
            {
                Native.CloseHandle(handle);
            }
            if (!ok)
            {
                return Fail("command-failed", "结束进程失败（Win32 错误 " + Marshal.GetLastWin32Error() + "）", 3);
            }
            Emit("{\"pid\":" + pid.ToString(CultureInfo.InvariantCulture) + ",\"killed\":true}");
            return 0;
        }

        /* =============================================================== helpers */

        private static long ToEpochMicro(DateTime utc)
        {
            return (utc.ToFileTimeUtc() - _epochBase) / 10L;
        }

        private static int Fail(string code, string message, int exitCode)
        {
            Emit("{\"error\":{\"code\":" + Quote(code) + ",\"message\":" + Quote(message) + "}}");
            return exitCode;
        }

        private static void Emit(string json)
        {
            byte[] bytes = new UTF8Encoding(false).GetBytes(json);
            using (Stream stdout = Console.OpenStandardOutput())
            {
                stdout.Write(bytes, 0, bytes.Length);
                stdout.Flush();
            }
        }

        internal static string Quote(string value)
        {
            if (value == null) return "null";
            StringBuilder builder = new StringBuilder(value.Length + 8);
            builder.Append('"');
            foreach (char ch in value)
            {
                switch (ch)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\b': builder.Append("\\b"); break;
                    case '\f': builder.Append("\\f"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (ch < ' ' || ch == '\u007f') builder.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                        else builder.Append(ch);
                        break;
                }
            }
            builder.Append('"');
            return builder.ToString();
        }
    }

    /// <summary>One Win32_Process row: the fields .NET does not expose.</summary>
    internal sealed class Win32Row
    {
        public int Pid;
        public int ParentPid;
        public string Name;
        public string ExecutablePath;
        public string CommandLine;
        public string Owner;
        public long StartMicro;
        public double At;
    }

    /// <summary>WMI access, always through a ProcessId filter (never a class scan) in detail.</summary>
    internal static class Win32Query
    {
        private const string Fields = "ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate";
        private const int BatchSize = 60;

        public static IEnumerable<Win32Row> ForPids(IList<int> pids)
        {
            List<Win32Row> rows = new List<Win32Row>(pids.Count);
            HashSet<int> seen = new HashSet<int>();
            List<int> unique = new List<int>(pids.Count);
            foreach (int pid in pids)
            {
                if (seen.Add(pid)) unique.Add(pid);
            }
            for (int offset = 0; offset < unique.Count; offset += BatchSize)
            {
                int take = Math.Min(BatchSize, unique.Count - offset);
                StringBuilder filter = new StringBuilder("(");
                for (int index = 0; index < take; index++)
                {
                    if (index > 0) filter.Append(" OR ");
                    filter.Append("ProcessId=").Append(unique[offset + index].ToString(CultureInfo.InvariantCulture));
                }
                filter.Append(')');
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT " + Fields + " FROM Win32_Process WHERE " + filter))
                {
                    using (ManagementObjectCollection results = searcher.Get())
                    {
                        foreach (ManagementObject item in results)
                        {
                            Win32Row row = Map(item);
                            if (row != null) rows.Add(row);
                            item.Dispose();
                        }
                    }
                }
            }
            return rows;
        }

        public static Dictionary<int, List<int>> ChildrenIndex(IList<int> pids)
        {
            Dictionary<int, List<int>> index = new Dictionary<int, List<int>>();
            HashSet<int> unique = new HashSet<int>(pids);
            if (unique.Count == 0) return index;
            StringBuilder filter = new StringBuilder("(");
            bool first = true;
            foreach (int pid in unique)
            {
                if (!first) filter.Append(" OR ");
                first = false;
                filter.Append("ParentProcessId=").Append(pid.ToString(CultureInfo.InvariantCulture));
            }
            filter.Append(')');
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT ProcessId,ParentProcessId FROM Win32_Process WHERE " + filter))
                {
                    using (ManagementObjectCollection results = searcher.Get())
                    {
                        foreach (ManagementObject item in results)
                        {
                            int pid = ToInt(item["ProcessId"]);
                            int parent = ToInt(item["ParentProcessId"]);
                            if (pid > 0 && unique.Contains(parent))
                            {
                                List<int> list;
                                if (!index.TryGetValue(parent, out list))
                                {
                                    list = new List<int>(4);
                                    index[parent] = list;
                                }
                                list.Add(pid);
                            }
                            item.Dispose();
                        }
                    }
                }
            }
            catch (Exception)
            {
                // children are optional information
            }
            return index;
        }

        private static Win32Row Map(ManagementObject item)
        {
            try
            {
                Win32Row row = new Win32Row();
                row.Pid = ToInt(item["ProcessId"]);
                if (row.Pid <= 0) return null;
                row.ParentPid = ToInt(item["ParentProcessId"]);
                row.Name = NullIfEmpty(Convert.ToString(item["Name"], CultureInfo.InvariantCulture));
                row.ExecutablePath = NullIfEmpty(Convert.ToString(item["ExecutablePath"], CultureInfo.InvariantCulture));
                row.CommandLine = NullIfEmpty(Convert.ToString(item["CommandLine"], CultureInfo.InvariantCulture));
                object created = item["CreationDate"];
                // CreationDate must be converted with the SAME epoch as the .NET StartTime values
                // (ToEpochMicro), otherwise Fresh() can never match a cached row and every refresh
                // pays the WMI cost again.
                if (created is DateTime) row.StartMicro = ToEpochMicro(((DateTime)created).ToUniversalTime());
                return row;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// Microseconds since the Unix epoch. The .NET process table and the WMI CreationDate
        /// column both go through the same conversion, so a cached row can be validated against
        /// the live start time of the pid (guards against pid reuse).
        /// </summary>
        private static long ToEpochMicro(DateTime utc)
        {
            return (utc.ToFileTimeUtc() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).ToFileTimeUtc()) / 10L;
        }

        private static string NullIfEmpty(string value)
        {
            return string.IsNullOrEmpty(value) ? null : value;
        }

        private static int ToInt(object value)
        {
            if (value == null) return 0;
            try
            {
                return Convert.ToInt32(value, CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return 0;
            }
        }
    }

    /// <summary>
    /// Command-line cache: `pid,readAt,startMicro,parentPid,exe,cmdline` per line, tab separated,
    /// stored inside the plugin data directory. Command lines may contain secrets, so the file
    /// never leaves that directory and is only read by this helper.
    /// </summary>
    internal static class WmiCache
    {
        private static readonly Encoding Utf8 = new UTF8Encoding(false);

        public static Dictionary<int, Win32Row> Load(string path)
        {
            Dictionary<int, Win32Row> rows = new Dictionary<int, Win32Row>();
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return rows;
            try
            {
                foreach (string line in File.ReadAllLines(path, Utf8))
                {
                    string[] parts = line.Split('\t');
                    if (parts.Length < 6) continue;
                    int pid;
                    double at;
                    long startMicro;
                    int parent;
                    if (!int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out pid)) continue;
                    if (!double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out at)) continue;
                    long.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out startMicro);
                    int.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out parent);
                    Win32Row row = new Win32Row();
                    row.Pid = pid;
                    row.At = at;
                    row.StartMicro = startMicro;
                    row.ParentPid = parent;
                    row.ExecutablePath = Empty(parts[4]);
                    row.CommandLine = Empty(parts[5]);
                    rows[pid] = row;
                }
            }
            catch (Exception)
            {
                return new Dictionary<int, Win32Row>();
            }
            return rows;
        }

        public static void Save(string path, Dictionary<int, Win32Row> rows)
        {
            StringBuilder builder = new StringBuilder(16 * 1024);
            foreach (KeyValuePair<int, Win32Row> pair in rows)
            {
                Win32Row row = pair.Value;
                builder.Append(pair.Key.ToString(CultureInfo.InvariantCulture)).Append('\t')
                       .Append(row.At.ToString("F3", CultureInfo.InvariantCulture)).Append('\t')
                       .Append(row.StartMicro.ToString(CultureInfo.InvariantCulture)).Append('\t')
                       .Append(row.ParentPid.ToString(CultureInfo.InvariantCulture)).Append('\t')
                       .Append(Clean(row.ExecutablePath)).Append('\t')
                       .Append(Clean(row.CommandLine)).Append('\n');
            }
            string temporary = path + ".tmp";
            File.WriteAllText(temporary, builder.ToString(), Utf8);
            if (File.Exists(path)) File.Delete(path);
            File.Move(temporary, path);
        }

        private static string Clean(string value)
        {
            return value == null ? string.Empty : value.Replace('\t', ' ').Replace('\n', ' ').Replace('\r', ' ');
        }

        private static string Empty(string value)
        {
            return string.IsNullOrEmpty(value) ? null : value;
        }
    }

    /// <summary>
    /// Read-only view of another process' PEB: working directory and environment block.
    /// The PEB layout differs per target bitness; when the target runs a different bitness than
    /// this helper the read is reported as bits-mismatch instead of returning garbage.
    /// </summary>
    internal sealed class RemoteMemory : IDisposable
    {
        private const int EnvironmentByteLimit = 0x8000;
        private readonly IntPtr _handle;
        private readonly bool _targetIs64;
        private bool _disposed;

        public string LastErrorCode { get; private set; }

        private RemoteMemory(IntPtr handle, bool targetIs64)
        {
            _handle = handle;
            _targetIs64 = targetIs64;
        }

        public static RemoteMemory Open(int pid)
        {
            IntPtr handle = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION | Native.PROCESS_VM_READ, false, pid);
            if (handle == IntPtr.Zero) return null;
            return new RemoteMemory(handle, Native.TargetIs64Bit(handle));
        }

        public string WorkingDirectory(out string code)
        {
            code = null;
            ProcessParameters parameters = null;
            try
            {
                parameters = ProcessParameters.Read(_handle, _targetIs64);
                if (!parameters.Valid)
                {
                    code = parameters.ErrorCode;
                    return null;
                }
                return parameters.CurrentDirectory();
            }
            catch (UnauthorizedAccessException)
            {
                code = "access-denied";
                return null;
            }
            catch (Exception error)
            {
                code = "unsupported";
                LastErrorCode = error.GetType().Name;
                return null;
            }
            finally
            {
                if (parameters != null) parameters.Dispose();
            }
        }

        /// <summary>
        /// Reads the environment block. The block is a UNICODE_STRING inside ProcessParameters;
        /// its position varies, so every plausible field in the copied window is tried and the
        /// largest block containing `SystemRoot=` wins. Never throws.
        /// </summary>
        public Dictionary<string, string> Environment()
        {
            try
            {
                ProcessParameters parameters = ProcessParameters.Read(_handle, _targetIs64);
                if (!parameters.Valid)
                {
                    LastErrorCode = parameters.ErrorCode;
                    return null;
                }
                Dictionary<string, string> best = null;
                int bestScore = int.MinValue;
                bool denied = false;
                for (int slot = 0x8; slot + 16 <= 0x800; slot += 8)
                {
                    int length = parameters.ReadUInt16(slot);
                    int maximum = parameters.ReadUInt16(slot + 2);
                    if (length <= 1 || length > EnvironmentByteLimit || (length & 1) != 0) continue;
                    if (maximum < length) continue;
                    IntPtr pointer = parameters.ReadPointerRaw(slot + 8);
                    if (pointer == IntPtr.Zero) continue;
                    byte[] bytes;
                    try { bytes = Read(pointer, length); }
                    catch (UnauthorizedAccessException) { denied = true; continue; }
                    Dictionary<string, string> parsed = ParseBlock(bytes);
                    if (parsed == null || parsed.Count < 2) continue;
                    if (!parsed.ContainsKey("SystemRoot") && !parsed.ContainsKey("SYSTEMROOT")) continue;
                    // The real block starts with a drive variable (=C:=...) or the first KEY=VALUE;
                    // a fragment starts mid-value. Prefer the longest AND most complete block.
                    // A fragment begins mid-value; a real block begins at an entry boundary and ends
                    // with the double null. Score both, keep the best (ties: more entries).
                    int score = parsed.Count + (EndsCleanly(bytes) ? 1000 : 0);
                    if (best == null || score > bestScore)
                    {
                        best = parsed;
                        bestScore = score;
                    }
                }
                if (best != null) return best;
                LastErrorCode = denied ? "access-denied" : "unsupported";
                return null;
            }
            catch (UnauthorizedAccessException)
            {
                LastErrorCode = "access-denied";
                return null;
            }
            catch (Exception error)
            {
                LastErrorCode = "unsupported";
                LastErrorMessage = error.GetType().Name;
                return null;
            }
        }

        public string LastErrorMessage { get; private set; }

        private int LengthPointerGap
        {
            get { return _targetIs64 ? 8 : 4; }
        }

        /// <summary>True when the buffer is a well-formed block terminated by its double null.</summary>
        private static bool EndsCleanly(byte[] bytes)
        {
            if (bytes == null || bytes.Length < 4) return false;
            int index = 0;
            while (index + 1 < bytes.Length && (bytes[index] != 0 || bytes[index + 1] != 0)) index += 2;
            if (index + 1 >= bytes.Length) return false;   // no terminator: truncated read
            return index + 2 >= bytes.Length - 1;          // the terminator closes the buffer
        }

        private static Dictionary<string, string> ParseBlock(byte[] bytes)
        {
            Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            int start = 0;
            while (start + 1 < bytes.Length)
            {
                int end = start;
                while (end + 1 < bytes.Length && (bytes[end] != 0 || bytes[end + 1] != 0)) end += 2;
                if (end == start) break;
                string entry = Encoding.Unicode.GetString(bytes, start, end - start);
                int equals = entry.IndexOf('=');
                if (equals == 0) equals = entry.IndexOf('=', 1);
                if (equals > 0 && equals < entry.Length - 1)
                {
                    string key = entry.Substring(0, equals);
                    if (!map.ContainsKey(key)) map[key] = entry.Substring(equals + 1);
                }
                start = end + 2;
            }
            return map;
        }

        private byte[] Read(IntPtr address, int length)
        {
            byte[] buffer = new byte[length];
            IntPtr read;
            if (!Native.ReadProcessMemory(_handle, address, buffer, (IntPtr)length, out read) || (int)read < length)
            {
                throw new UnauthorizedAccessException("read failed");
            }
            return buffer;
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            Native.CloseHandle(_handle);
        }
    }

    /// <summary>
    /// A private copy of RTL_USER_PROCESS_PARAMETERS. The PEB hands out a pointer that may point
    /// into the middle of an extended block, so a window around it is copied once and all readers
    /// index into that copy (SHA256-free, allocation-free after construction).
    /// </summary>
    internal sealed class ProcessParameters : IDisposable
    {
        internal const int WindowBefore = 0x400;
        internal const int WindowAfter = 0x400;
        private IntPtr _buffer;
        private IntPtr _handleForScan;
        private bool _target64;

        public bool Valid;
        public string ErrorCode;
        public int Size;
        public int CurrentDirectoryOffset;

        public static ProcessParameters Read(IntPtr handle, bool targetIs64)
        {
            ProcessParameters result = new ProcessParameters();
            result._handleForScan = handle;
            result._target64 = targetIs64;
            int returned;
            PROCESS_BASIC_INFORMATION information;
            int status = Native.NtQueryInformationProcess(handle, 0, out information,
                Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returned);
            if (status != 0 || information.PebBaseAddress == IntPtr.Zero)
            {
                result.ErrorCode = "access-denied";
                return result;
            }

            long peb = information.PebBaseAddress.ToInt64();
            long parameters;
            if (targetIs64 && IntPtr.Size == 8)
            {
                byte[] slice = new byte[8];
                IntPtr read;
                if (!Native.ReadProcessMemory(handle, (IntPtr)(peb + 0x20), slice, (IntPtr)8, out read))
                {
                    result.ErrorCode = "access-denied";
                    return result;
                }
                parameters = BitConverter.ToInt64(slice, 0);
            }
            else
            {
                byte[] slice = new byte[4];
                IntPtr read;
                if (!Native.ReadProcessMemory(handle, (IntPtr)(peb + 0x10), slice, (IntPtr)4, out read))
                {
                    result.ErrorCode = "access-denied";
                    return result;
                }
                parameters = BitConverter.ToUInt32(slice, 0);
            }
            if (parameters == 0)
            {
                result.ErrorCode = "unsupported";
                return result;
            }

            byte[] window = new byte[WindowBefore + WindowAfter];
            IntPtr got;
            if (!Native.ReadProcessMemory(handle, (IntPtr)(parameters - WindowBefore), window, (IntPtr)window.Length, out got))
            {
                result.ErrorCode = "access-denied";
                return result;
            }
            result._buffer = Marshal.AllocHGlobal(window.Length);
            Marshal.Copy(window, 0, result._buffer, window.Length);
            result.Size = window.Length;
            // The window is indexed by *absolute* offsets from the PEB-provided pointer, so a
            // negative logical offset is stored as WindowBefore + offset.
            result.CurrentDirectoryOffset = result.DetectCurrentDirectory();
            result.Valid = true;
            return result;
        }

        /// <summary>
        /// Locate the CURDIR field: the UNICODE_STRING whose buffer decodes as an existing
        /// absolute drive path ("C:\..."). Scans the classic offsets first, then the whole window.
        /// </summary>
        private int DetectCurrentDirectory()
        {
            int[] classic = _target64
                ? new[] { -0x40, 0x38, 0x40 }
                : new[] { -0x40, 0x24 };
            foreach (int offset in classic)
            {
                if (LooksLikeDirectory(offset)) return offset;
            }
            for (int offset = -WindowBefore + 0x10; offset + 16 < WindowAfter; offset += 8)
            {
                if (LooksLikeDirectory(offset)) return offset;
            }
            return classic[0];
        }

        private bool LooksLikeDirectory(int offset)
        {
            try
            {
                int normalized = WindowBefore + offset;
                if (normalized < 0 || normalized + 16 > Size) return false;
                int length = (ushort)Marshal.ReadInt16(_buffer, normalized);
                if (length < 6 || length > 0x1000 || (length & 1) != 0) return false;
                IntPtr pointer = Marshal.ReadIntPtr(_buffer, normalized + (IntPtr.Size == 8 ? 8 : 4));
                if (pointer == IntPtr.Zero) return false;
                byte[] bytes = new byte[length];
                IntPtr read;
                if (!Native.ReadProcessMemory(_handleForScan, pointer, bytes, (IntPtr)length, out read)) return false;
                string text = Encoding.Unicode.GetString(bytes);
                return text.Length > 2 && text[1] == ':' && (text[2] == '\\' || text[2] == '/');
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>Read the CURDIR DOS path (the process working directory).</summary>
        public string CurrentDirectory()
        {
            int offset = CurrentDirectoryOffset;
            int length = ReadUInt16(offset);
            IntPtr pointer = ReadPointer(offset + (_target64 ? 8 : 4));
            if (pointer == IntPtr.Zero || length <= 0 || length > 0x8000) return null;
            byte[] bytes = new byte[length];
            IntPtr read;
            if (!Native.ReadProcessMemory(_handleForScan, pointer, bytes, (IntPtr)length, out read)) return null;
            return Encoding.Unicode.GetString(bytes);
        }

        public int ReadInt32(int offset)
        {
            return Marshal.ReadInt32(_buffer, Normalize(offset));
        }

        /// <summary>Raw window access (no PEB base translation): used by the environment scan.</summary>
        public int ReadUInt16Raw(int index)
        {
            return (ushort)Marshal.ReadInt16(_buffer, NormalizeRaw(index));
        }

        public IntPtr ReadPointerRaw(int index)
        {
            int normalized = NormalizeRaw(index);
            return IntPtr.Size == 8 ? (IntPtr)Marshal.ReadInt64(_buffer, normalized) : (IntPtr)Marshal.ReadInt32(_buffer, normalized);
        }

        private int NormalizeRaw(int index)
        {
            int value = index;
            if (value < 0) value = 0;
            if (value > Size - 8) value = Size - 8;
            return value;
        }

        public int ReadUInt16(int offset)
        {
            return (ushort)Marshal.ReadInt16(_buffer, Normalize(offset));
        }

        public IntPtr ReadPointer(int offset)
        {
            int normalized = Normalize(offset);
            return IntPtr.Size == 8 ? (IntPtr)Marshal.ReadInt64(_buffer, normalized) : (IntPtr)Marshal.ReadInt32(_buffer, normalized);
        }

        private int Normalize(int offset)
        {
            int value = offset + WindowBefore;
            if (value < 0) value = 0;
            if (value > Size - 8) value = Size - 8;
            return value;
        }

        public void Dispose()
        {
            if (_buffer == IntPtr.Zero) return;
            Marshal.FreeHGlobal(_buffer);
            _buffer = IntPtr.Zero;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    internal static class Native
    {
        public const int PROCESS_TERMINATE = 0x0001;
        public const int PROCESS_QUERY_INFORMATION = 0x0400;
        public const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const int PROCESS_VM_READ = 0x0010;

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(int access, bool inherit, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr handle, uint exitCode);

        [DllImport("ntdll.dll")]
        public static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, out PROCESS_BASIC_INFORMATION info, int size, out int returned);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsWow64Process(IntPtr handle, out bool wow64);

        [DllImport("kernel32.dll", EntryPoint = "IsWow64Process2", SetLastError = true)]
        private static extern bool IsWow64Process2Native(IntPtr handle, out ushort processMachine, out ushort nativeMachine);

        /// <summary>True when the target process' PEB uses 64-bit pointers.</summary>
        public static bool TargetIs64Bit(IntPtr handle)
        {
            try
            {
                ushort processMachine;
                ushort nativeMachine;
                if (IsWow64Process2Native(handle, out processMachine, out nativeMachine))
                {
                    // processMachine == 0 means "not WOW64" (runs natively); a WOW64 target reports
                    // the emulated machine but still has a 64-bit PEB.
                    return IntPtr.Size == 8;
                }
            }
            catch (EntryPointNotFoundException)
            {
                // Windows 7/8/8.1: fall back to IsWow64Process
            }
            bool wow64;
            if (!IsWow64Process(handle, out wow64)) return IntPtr.Size == 8;
            return IntPtr.Size == 8;
        }
    }
}
