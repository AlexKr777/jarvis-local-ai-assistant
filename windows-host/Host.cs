using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace JarvisVoiceHost
{
    internal static class Program
    {
        internal const string MutexName = "Local\\JARVIS_VOICE_HOST_V1";
        internal const string StopEventName = "Local\\JARVIS_VOICE_HOST_STOP_V1";
        internal const string OpenEventName = "Local\\JARVIS_VOICE_HOST_OPEN_V1";

        [STAThread]
        private static int Main(string[] args)
        {
            if (HasArgument(args, "--self-test")) return RunSelfTest();
            if (HasArgument(args, "--audio-self-test")) return RunAudioSelfTest();
            if (HasArgument(args, "--stop")) return SignalExisting(StopEventName);
            if (HasArgument(args, "--open")) return SignalExisting(OpenEventName);

            bool created;
            using (Mutex mutex = new Mutex(true, MutexName, out created))
            {
                if (!created)
                {
                    if (!HasArgument(args, "--background")) SignalExisting(OpenEventName);
                    return 0;
                }

                WindowsDisplay.EnableDpiAwareness();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
                Application.Run(new HostApplicationContext(root, !HasArgument(args, "--background")));
                GC.KeepAlive(mutex);
            }
            return 0;
        }

        private static bool HasArgument(string[] args, string expected)
        {
            foreach (string value in args)
            {
                if (string.Equals(value, expected, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static int SignalExisting(string eventName)
        {
            try
            {
                using (EventWaitHandle signal = EventWaitHandle.OpenExisting(eventName)) signal.Set();
                return 0;
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                return 0;
            }
        }

        private static int RunSelfTest()
        {
            PttStateMachine state = new PttStateMachine();
            bool quickTapIgnored = state.KeyDown(PttStateMachine.VK_RCONTROL, false, 0) == PttAction.Armed
                && state.KeyUp(PttStateMachine.VK_RCONTROL, false, 100) == PttAction.None;

            state.Reset();
            bool longPressRecords = state.KeyDown(PttStateMachine.VK_RCONTROL, false, 0) == PttAction.Armed
                && state.Tick(PttStateMachine.HoldThresholdMs) == PttAction.StartRecording
                && state.KeyUp(PttStateMachine.VK_RCONTROL, false, 500) == PttAction.StopRecording;

            state.Reset();
            bool chordCancels = state.KeyDown(PttStateMachine.VK_RCONTROL, false, 0) == PttAction.Armed
                && state.KeyDown(0x41, false, 50) == PttAction.CancelRecording;

            state.Reset();
            bool escapeCancels = state.KeyDown(PttStateMachine.VK_RCONTROL, false, 0) == PttAction.Armed
                && state.Tick(PttStateMachine.HoldThresholdMs) == PttAction.StartRecording
                && state.KeyDown(PttStateMachine.VK_ESCAPE, false, 250) == PttAction.CancelRecording;

            state.Reset();
            bool leftControlIgnored = state.KeyDown(PttStateMachine.VK_LCONTROL, false, 0) == PttAction.None;
            bool injectedIgnored = state.KeyDown(PttStateMachine.VK_RCONTROL, true, 0) == PttAction.None;

            state.Reset();
            bool maxDurationStops = state.KeyDown(PttStateMachine.VK_RCONTROL, false, 0) == PttAction.Armed
                && state.Tick(PttStateMachine.HoldThresholdMs) == PttAction.StartRecording
                && state.Tick(PttStateMachine.HoldThresholdMs + PttStateMachine.MaximumRecordingMs) == PttAction.StopRecording;

            string json = "{\"quickTapIgnored\":" + Lower(quickTapIgnored)
                + ",\"longPressRecords\":" + Lower(longPressRecords)
                + ",\"chordCancels\":" + Lower(chordCancels)
                + ",\"escapeCancels\":" + Lower(escapeCancels)
                + ",\"leftControlIgnored\":" + Lower(leftControlIgnored)
                + ",\"injectedIgnored\":" + Lower(injectedIgnored)
                + ",\"maxDurationStops\":" + Lower(maxDurationStops) + "}";
            Console.WriteLine(json);
            return quickTapIgnored && longPressRecords && chordCancels && escapeCancels
                && leftControlIgnored && injectedIgnored && maxDurationStops ? 0 : 1;
        }

        private static int RunAudioSelfTest()
        {
            WaveInRecorder recorder = new WaveInRecorder();
            try
            {
                recorder.Start();
                Thread.Sleep(800);
                AudioRecording recording = recorder.Stop();
                Console.WriteLine("{\"microphoneOpened\":true,\"durationMs\":" + recording.DurationMs
                    + ",\"wavBytes\":" + recording.WavBytes.Length + ",\"rawAudioSaved\":false}");
                return recording.DurationMs >= 500 && recording.DurationMs <= 1500
                    && recording.WavBytes.Length > 44 ? 0 : 1;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                Console.WriteLine("{\"microphoneOpened\":false,\"durationMs\":0,\"wavBytes\":0,\"rawAudioSaved\":false}");
                return 1;
            }
            finally
            {
                recorder.Dispose();
            }
        }

        private static string Lower(bool value) { return value ? "true" : "false"; }
    }

    internal sealed class AutostartManager
    {
        private const string RunPath = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        private const string ValueName = "JARVIS Voice Host";
        private readonly string command;

        internal AutostartManager(string executablePath)
        {
            command = "\"" + executablePath + "\" --background";
        }

        internal bool IsEnabled
        {
            get
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunPath, false))
                {
                    string value = key == null ? null : key.GetValue(ValueName) as string;
                    return string.Equals(value, command, StringComparison.OrdinalIgnoreCase);
                }
            }
        }

        internal void SetEnabled(bool enabled)
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RunPath))
            {
                if (enabled)
                {
                    if (!string.Equals(key.GetValue(ValueName) as string, command, StringComparison.OrdinalIgnoreCase))
                        key.SetValue(ValueName, command, RegistryValueKind.String);
                }
                else if (key.GetValue(ValueName) != null)
                {
                    key.DeleteValue(ValueName, false);
                }
            }
        }
    }

    internal sealed class HostDiagnostics
    {
        private const long MaxBytes = 512 * 1024;
        private readonly string filePath;
        private readonly string previousPath;
        private readonly object gate = new object();

        internal HostDiagnostics(string projectRoot)
        {
            string directory = Path.Combine(projectRoot, "logs");
            filePath = Path.Combine(directory, "windows-host.log");
            previousPath = Path.Combine(directory, "windows-host.previous.log");
        }

        internal void Write(string code)
        {
            try
            {
                lock (gate)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(filePath));
                    if (File.Exists(filePath) && new FileInfo(filePath).Length >= MaxBytes)
                    {
                        if (File.Exists(previousPath)) File.Delete(previousPath);
                        File.Move(filePath, previousPath);
                    }
                    File.AppendAllText(filePath, DateTime.UtcNow.ToString("o") + " " + code + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch { }
        }
    }

    internal sealed class PttLatencyTrace
    {
        private readonly long[] marks = new long[10];
        private readonly string id = Guid.NewGuid().ToString("N");
        private bool written;
        internal long ModelLoadMs;
        internal long AsrMs;
        internal bool Warm;

        internal void Mark(int index)
        {
            Mark(index, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        internal void Mark(int index, long value)
        {
            if (index >= 0 && index < marks.Length && value > 0) marks[index] = value;
        }

        internal void Write(HostDiagnostics diagnostics, string outcome)
        {
            if (written || diagnostics == null) return;
            written = true;
            StringBuilder line = new StringBuilder("ptt_latency id=");
            line.Append(id).Append(" outcome=").Append(outcome);
            for (int index = 0; index < marks.Length; index++)
                line.Append(" T").Append(index).Append('=').Append(marks[index]);
            line.Append(" modelLoadMs=").Append(ModelLoadMs)
                .Append(" asrMs=").Append(AsrMs)
                .Append(" warm=").Append(Warm ? "true" : "false");
            diagnostics.Write(line.ToString());
        }
    }

    internal sealed class OverlayForm : Form
    {
        internal const int AnswerTimeoutMs = 15000;
        private const double CardOpacity = 0.97;
        private readonly Label title;
        private readonly Label detail;
        private readonly Label footer;
        private readonly System.Windows.Forms.Timer hideTimer;
        private readonly System.Windows.Forms.Timer dotsTimer;
        private readonly System.Windows.Forms.Timer transitionTimer;
        private readonly GlobalMouseDownObserver dismissObserver;
        private string dotsBase;
        private int dots;
        private Color identityColor;
        private Point settledLocation;
        private DateTime transitionStartedAt;
        private int transitionDirection;
        private int settleDistance;
        private DisplayTarget currentTarget;
        private float layoutScale = 1f;

        internal OverlayForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Color.FromArgb(22, 24, 27);
            ForeColor = Color.FromArgb(238, 240, 242);
            ClientSize = new Size(360, 116);
            DoubleBuffered = true;
            Opacity = CardOpacity;
            identityColor = Color.FromArgb(184, 190, 197);

            title = new Label();
            title.AutoSize = false;
            title.Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Regular);
            title.ForeColor = Color.FromArgb(208, 212, 217);
            title.BackColor = Color.Transparent;
            Controls.Add(title);

            detail = new Label();
            detail.AutoEllipsis = true;
            detail.Font = new Font("Segoe UI", 10.5f, FontStyle.Regular);
            detail.ForeColor = Color.FromArgb(239, 241, 243);
            detail.BackColor = Color.Transparent;
            Controls.Add(detail);

            footer = new Label();
            footer.AutoSize = false;
            footer.Font = new Font("Segoe UI", 8.5f, FontStyle.Regular);
            footer.ForeColor = Color.FromArgb(144, 150, 157);
            footer.BackColor = Color.Transparent;
            footer.Text = "Полный ответ сохранён в JARVIS";
            footer.Visible = false;
            Controls.Add(footer);

            hideTimer = new System.Windows.Forms.Timer();
            hideTimer.Tick += delegate { hideTimer.Stop(); Dismiss(false); };
            dotsTimer = new System.Windows.Forms.Timer();
            dotsTimer.Interval = 320;
            dotsTimer.Tick += delegate
            {
                dots = (dots + 1) % 4;
                title.Text = dotsBase + new string('·', dots);
            };

            transitionTimer = new System.Windows.Forms.Timer();
            transitionTimer.Interval = 16;
            transitionTimer.Tick += delegate { TickTransition(); };
            dismissObserver = new GlobalMouseDownObserver(delegate { Dismiss(true); }, SynchronizationContext.Current);
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                const int WS_EX_TOOLWINDOW = 0x00000080;
                const int WS_EX_NOACTIVATE = 0x08000000;
                const int WS_EX_TRANSPARENT = 0x00000020;
                const int CS_DROPSHADOW = 0x00020000;
                CreateParams value = base.CreateParams;
                value.ExStyle |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT;
                value.ClassStyle |= CS_DROPSHADOW;
                return value;
            }
        }

        internal void ShowState(string heading, string text, Color color, bool animate, int hideAfterMs)
        {
            ShowCard(heading, text, color, animate, hideAfterMs, false, false);
        }

        internal void ShowAnswer(string text, bool truncated)
        {
            ShowCard("JARVIS", text, Color.FromArgb(205, 210, 216), false, AnswerTimeoutMs, true, truncated);
        }

        internal void ShowActionSuccess(string text)
        {
            ShowCard("Готово", text, Color.FromArgb(117, 198, 155), false, 3200, false, false);
        }

        internal void BeginSession()
        {
            Dismiss(true);
        }

        private void ShowCard(string heading, string text, Color color, bool animate, int hideAfterMs, bool dismissOnClick, bool truncated)
        {
            hideTimer.Stop();
            dotsTimer.Stop();
            transitionTimer.Stop();
            dismissObserver.Disable();
            dotsBase = heading;
            dots = 0;
            title.Text = heading;
            detail.Text = text ?? string.Empty;
            footer.Visible = truncated;
            identityColor = color;

            bool entering = !Visible;
            DisplayTarget target = entering || currentTarget == null ? WindowsDisplay.ActiveTarget() : currentTarget;
            currentTarget = target;
            ApplyLayout(target.Scale, truncated);
            Rectangle work = target.Screen.WorkingArea;
            int inset = Scale(22, target.Scale);
            settledLocation = new Point(work.Left + inset, work.Top + inset);
            settleDistance = Scale(4, target.Scale);
            Location = entering && WindowsDisplay.AnimationsEnabled
                ? new Point(settledLocation.X, settledLocation.Y - settleDistance)
                : settledLocation;
            ApplyRoundedRegion(Scale(32, target.Scale));

            if (entering)
            {
                Opacity = WindowsDisplay.AnimationsEnabled ? 0.12 : CardOpacity;
                Show();
                if (WindowsDisplay.AnimationsEnabled)
                {
                    transitionDirection = 1;
                    transitionStartedAt = DateTime.UtcNow;
                    transitionTimer.Start();
                }
            }
            else
            {
                Opacity = CardOpacity;
            }
            Invalidate();
            if (animate) dotsTimer.Start();
            if (dismissOnClick)
            {
                try { dismissObserver.Enable(); } catch { }
            }
            if (hideAfterMs > 0)
            {
                hideTimer.Interval = hideAfterMs;
                hideTimer.Start();
            }
        }

        private void ApplyLayout(float scale, bool truncated)
        {
            layoutScale = scale;
            int width = Scale(360, scale);
            int horizontal = Scale(18, scale);
            int top = Scale(15, scale);
            int orbSpace = Scale(20, scale);
            int titleHeight = Scale(20, scale);
            int bodyTop = top + titleHeight + Scale(7, scale);
            int bodyWidth = width - (horizontal * 2);
            int maxBodyHeight = Scale(116, scale);
            Size measured = TextRenderer.MeasureText(detail.Text, detail.Font, new Size(bodyWidth, maxBodyHeight),
                TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
            int lineHeight = TextRenderer.MeasureText("Ag", detail.Font, new Size(bodyWidth, maxBodyHeight),
                TextFormatFlags.NoPadding).Height;
            int bodyHeight = Math.Min(lineHeight * 6, Math.Max(lineHeight, measured.Height));
            int footerHeight = truncated ? Scale(18, scale) : 0;
            int height = bodyTop + bodyHeight + (truncated ? Scale(7, scale) + footerHeight : 0) + Scale(16, scale);

            ClientSize = new Size(width, height);
            title.Location = new Point(horizontal + orbSpace, top);
            title.Size = new Size(bodyWidth - orbSpace, titleHeight);
            detail.Location = new Point(horizontal, bodyTop);
            detail.Size = new Size(bodyWidth, bodyHeight);
            footer.Location = new Point(horizontal, bodyTop + bodyHeight + Scale(7, scale));
            footer.Size = new Size(bodyWidth, footerHeight);
        }

        private static int Scale(int value, float scale)
        {
            return Math.Max(1, (int)Math.Round(value * scale));
        }

        private void ApplyRoundedRegion(int radius)
        {
            IntPtr shape = CreateRoundRectRgn(0, 0, Width + 1, Height + 1, radius, radius);
            try
            {
                System.Drawing.Region old = Region;
                Region = System.Drawing.Region.FromHrgn(shape);
                if (old != null) old.Dispose();
            }
            finally { DeleteObject(shape); }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using (Pen border = new Pen(Color.FromArgb(72, 255, 255, 255), 1f))
                e.Graphics.DrawRoundedRectangle(border, new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), 16f * layoutScale);
            using (SolidBrush orb = new SolidBrush(identityColor))
                e.Graphics.FillEllipse(orb, new RectangleF(18f * layoutScale, 20f * layoutScale, 7f * layoutScale, 7f * layoutScale));
        }

        private void Dismiss(bool immediate)
        {
            hideTimer.Stop();
            dotsTimer.Stop();
            dismissObserver.Disable();
            if (!Visible) return;
            if (immediate || !WindowsDisplay.AnimationsEnabled)
            {
                transitionTimer.Stop();
                Hide();
                Opacity = CardOpacity;
                currentTarget = null;
                return;
            }
            transitionDirection = -1;
            transitionStartedAt = DateTime.UtcNow;
            transitionTimer.Start();
        }

        private void TickTransition()
        {
            int duration = transitionDirection > 0 ? 190 : 140;
            double progress = Math.Min(1.0, (DateTime.UtcNow - transitionStartedAt).TotalMilliseconds / duration);
            if (transitionDirection > 0)
            {
                double eased = 1.0 - Math.Pow(1.0 - progress, 3.0);
                Opacity = 0.12 + ((CardOpacity - 0.12) * eased);
                Location = new Point(settledLocation.X, settledLocation.Y - (int)Math.Round(settleDistance * (1.0 - eased)));
            }
            else
            {
                Opacity = CardOpacity * (1.0 - progress);
            }
            if (progress < 1.0) return;
            transitionTimer.Stop();
            if (transitionDirection < 0)
            {
                Hide();
                currentTarget = null;
            }
            Opacity = CardOpacity;
            Location = settledLocation;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                hideTimer.Dispose();
                dotsTimer.Dispose();
                transitionTimer.Dispose();
                dismissObserver.Dispose();
                title.Dispose();
                detail.Dispose();
                footer.Dispose();
            }
            base.Dispose(disposing);
        }

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int width, int height);

        [DllImport("gdi32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeleteObject(IntPtr value);
    }

    internal static class GraphicsExtensions
    {
        internal static void DrawRoundedRectangle(this Graphics graphics, Pen pen, RectangleF rectangle, float radius)
        {
            float diameter = radius * 2f;
            using (System.Drawing.Drawing2D.GraphicsPath path = new System.Drawing.Drawing2D.GraphicsPath())
            {
                path.AddArc(rectangle.Left, rectangle.Top, diameter, diameter, 180, 90);
                path.AddArc(rectangle.Right - diameter, rectangle.Top, diameter, diameter, 270, 90);
                path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
                path.AddArc(rectangle.Left, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
                path.CloseFigure();
                graphics.DrawPath(pen, path);
            }
        }
    }

    internal sealed class DisplayTarget
    {
        internal Screen Screen;
        internal float Scale;
    }

    internal static class WindowsDisplay
    {
        private const uint MONITOR_DEFAULTTONEAREST = 2;
        private const uint SPI_GETCLIENTAREAANIMATION = 0x1042;

        internal static bool AnimationsEnabled
        {
            get
            {
                bool enabled;
                return SystemParametersInfo(SPI_GETCLIENTAREAANIMATION, 0, out enabled, 0) && enabled;
            }
        }

        internal static void EnableDpiAwareness()
        {
            try { SetProcessDpiAwareness(2); }
            catch { try { SetProcessDPIAware(); } catch { } }
        }

        internal static DisplayTarget ActiveTarget()
        {
            IntPtr foreground = GetForegroundWindow();
            Screen screen = foreground != IntPtr.Zero ? Screen.FromHandle(foreground) : Screen.FromPoint(Cursor.Position);
            IntPtr monitor = foreground != IntPtr.Zero
                ? MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST)
                : MonitorFromPoint(new NativePoint(Cursor.Position.X, Cursor.Position.Y), MONITOR_DEFAULTTONEAREST);
            uint dpiX = 96;
            uint dpiY = 96;
            try
            {
                uint windowDpi = foreground == IntPtr.Zero ? 0 : GetDpiForWindow(foreground);
                if (windowDpi > 0) dpiX = windowDpi;
                else if (GetDpiForMonitor(monitor, 0, out dpiX, out dpiY) != 0) dpiX = 96;
            }
            catch
            {
                try { if (GetDpiForMonitor(monitor, 0, out dpiX, out dpiY) != 0) dpiX = 96; }
                catch { dpiX = 96; }
            }
            return new DisplayTarget { Screen = screen ?? Screen.PrimaryScreen, Scale = Math.Max(1f, dpiX / 96f) };
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct NativePoint
        {
            internal int X;
            internal int Y;
            internal NativePoint(int x, int y) { X = x; Y = y; }
        }

        [DllImport("user32.dll")]
        internal static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr window);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromPoint(NativePoint point, uint flags);

        [DllImport("shcore.dll")]
        private static extern int SetProcessDpiAwareness(int awareness);

        [DllImport("shcore.dll")]
        private static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SystemParametersInfo(uint action, uint parameter, out bool value, uint flags);
    }

    internal sealed class HostApiException : Exception
    {
        internal HttpStatusCode StatusCode;
        internal HostApiException(HttpStatusCode statusCode) : base("JARVIS host API request failed.")
        {
            StatusCode = statusCode;
        }
    }

    internal sealed class HostApiClient
    {
        private readonly string token;
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        private const string BaseUrl = "http://127.0.0.1:3210";

        internal HostApiClient(string tokenValue) { token = tokenValue; }

        internal async Task<bool> IsHealthyAsync()
        {
            try
            {
                Dictionary<string, object> value = await SendAsync("GET", "/api/host/status", null);
                return GetBool(value, "managed");
            }
            catch { return false; }
        }

        internal Task<Dictionary<string, object>> StatusAsync()
        {
            return SendAsync("GET", "/api/host/status", null);
        }

        internal Task<Dictionary<string, object>> TranscribeAsync(byte[] wav)
        {
            Dictionary<string, object> body = new Dictionary<string, object>();
            body["mime"] = "audio/wav";
            body["base64"] = Convert.ToBase64String(wav);
            return SendAsync("POST", "/api/host/transcriptions", body);
        }

        internal Task<Dictionary<string, object>> SubmitAsync(string transcript)
        {
            Dictionary<string, object> body = new Dictionary<string, object>();
            body["transcript"] = transcript;
            return SendAsync("POST", "/api/host/commands", body);
        }

        internal Task<Dictionary<string, object>> CommandStatusAsync(string commandId)
        {
            return SendAsync("GET", "/api/host/commands/" + Uri.EscapeDataString(commandId), null);
        }

        internal Task<Dictionary<string, object>> PauseAsync(bool paused)
        {
            Dictionary<string, object> body = new Dictionary<string, object>();
            body["paused"] = paused;
            return SendAsync("POST", "/api/host/pause", body);
        }

        internal Task<Dictionary<string, object>> ShutdownAsync()
        {
            return SendAsync("POST", "/api/host/shutdown", new Dictionary<string, object>());
        }

        private async Task<Dictionary<string, object>> SendAsync(string method, string path, object body)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(BaseUrl + path);
            request.Method = method;
            request.Headers[HttpRequestHeader.Authorization] = "Bearer " + token;
            request.Accept = "application/json";
            request.Timeout = 130000;
            request.ReadWriteTimeout = 130000;
            if (body != null)
            {
                byte[] payload = Encoding.UTF8.GetBytes(serializer.Serialize(body));
                request.ContentType = "application/json; charset=utf-8";
                request.ContentLength = payload.Length;
                using (Stream output = await request.GetRequestStreamAsync())
                    await output.WriteAsync(payload, 0, payload.Length);
            }

            try
            {
                using (HttpWebResponse response = (HttpWebResponse)await request.GetResponseAsync())
                using (Stream stream = response.GetResponseStream())
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                {
                    string json = await reader.ReadToEndAsync();
                    return serializer.Deserialize<Dictionary<string, object>>(json);
                }
            }
            catch (WebException error)
            {
                HttpWebResponse response = error.Response as HttpWebResponse;
                throw new HostApiException(response == null ? 0 : response.StatusCode);
            }
        }

        internal static string GetString(Dictionary<string, object> value, string key)
        {
            object item;
            return value != null && value.TryGetValue(key, out item) && item is string ? (string)item : null;
        }

        internal static bool GetBool(Dictionary<string, object> value, string key)
        {
            object item;
            return value != null && value.TryGetValue(key, out item) && item is bool && (bool)item;
        }

        internal static Dictionary<string, object> GetObject(Dictionary<string, object> value, string key)
        {
            object item;
            return value != null && value.TryGetValue(key, out item) ? item as Dictionary<string, object> : null;
        }

        internal static long GetLong(Dictionary<string, object> value, string key)
        {
            object item;
            if (value == null || !value.TryGetValue(key, out item) || item == null) return 0;
            try { return Convert.ToInt64(item); }
            catch { return 0; }
        }
    }

    internal sealed class BackendSupervisor : IDisposable
    {
        private readonly string projectRoot;
        private readonly string token;
        private readonly List<DateTime> starts = new List<DateTime>();
        private Process process;

        internal BackendSupervisor(string root)
        {
            projectRoot = root;
            byte[] random = new byte[32];
            using (RandomNumberGenerator generator = RandomNumberGenerator.Create()) generator.GetBytes(random);
            token = BitConverter.ToString(random).Replace("-", string.Empty).ToLowerInvariant();
            Api = new HostApiClient(token);
        }

        internal HostApiClient Api { get; private set; }

        internal async Task EnsureRunningAsync()
        {
            if (await Api.IsHealthyAsync()) return;
            if (process != null && !process.HasExited)
            {
                await WaitForHealthAsync();
                return;
            }

            DateTime cutoff = DateTime.UtcNow.AddMinutes(-1);
            starts.RemoveAll(delegate(DateTime value) { return value < cutoff; });
            if (starts.Count >= 3) throw new InvalidOperationException("Backend restart limit reached.");
            starts.Add(DateTime.UtcNow);

            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = "node.exe";
            info.Arguments = "src\\server.js";
            info.WorkingDirectory = projectRoot;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            info.EnvironmentVariables["JARVIS_HOST_TOKEN"] = token;
            info.EnvironmentVariables["JARVIS_NO_BROWSER"] = "1";
            process = Process.Start(info);
            await WaitForHealthAsync();
        }

        internal async Task RestartAsync()
        {
            await StopOwnedAsync();
            await EnsureRunningAsync();
        }

        internal async Task StopOwnedAsync()
        {
            Process owned = process;
            if (owned == null) return;
            if (!owned.HasExited)
            {
                try { await Api.ShutdownAsync(); } catch { }
                bool exited = await Task.Run(delegate { return owned.WaitForExit(5000); });
                if (!exited && !owned.HasExited) owned.Kill();
            }
            owned.Dispose();
            process = null;
        }

        private async Task WaitForHealthAsync()
        {
            for (int attempt = 0; attempt < 60; attempt++)
            {
                if (process != null && process.HasExited)
                    throw new InvalidOperationException("JARVIS backend stopped during startup.");
                if (await Api.IsHealthyAsync()) return;
                await Task.Delay(250);
            }
            throw new InvalidOperationException("JARVIS backend did not become ready.");
        }

        public void Dispose()
        {
            if (process != null) process.Dispose();
        }
    }

    internal sealed class HostApplicationContext : ApplicationContext
    {
        private const long MinimumRecordingMs = 350;
        private readonly string projectRoot;
        private readonly bool openOnStart;
        private readonly NotifyIcon tray;
        private readonly OverlayForm overlay;
        private readonly AutostartManager autostart;
        private readonly BackendSupervisor backend;
        private readonly HostDiagnostics diagnostics;
        private readonly PttStateMachine ptt = new PttStateMachine();
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly System.Windows.Forms.Timer pttTimer;
        private readonly EventWaitHandle stopSignal;
        private readonly EventWaitHandle openSignal;
        private readonly RegisteredWaitHandle stopWait;
        private readonly RegisteredWaitHandle openWait;
        private readonly SynchronizationContext synchronizationContext;
        private GlobalKeyboardHook keyboard;
        private WaveInRecorder recorder;
        private PttLatencyTrace activeTrace;
        private bool paused;
        private bool exiting;

        internal HostApplicationContext(string root, bool shouldOpen)
        {
            projectRoot = root;
            openOnStart = shouldOpen;
            synchronizationContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            overlay = new OverlayForm();
            backend = new BackendSupervisor(projectRoot);
            autostart = new AutostartManager(Application.ExecutablePath);
            diagnostics = new HostDiagnostics(projectRoot);

            MenuItem open = new MenuItem("Открыть JARVIS", delegate { Forget(OpenJarvisAsync()); });
            MenuItem voicePause = new MenuItem("Voice Pause", delegate(object sender, EventArgs args)
            {
                paused = !paused;
                ((MenuItem)sender).Checked = paused;
                ptt.Reset();
                CancelRecording();
                Forget(SetPauseAsync(paused));
            });
            MenuItem startWithWindows = new MenuItem("Запускать с Windows", delegate(object sender, EventArgs args)
            {
                try
                {
                    bool enable = !autostart.IsEnabled;
                    autostart.SetEnabled(enable);
                    ((MenuItem)sender).Checked = autostart.IsEnabled;
                }
                catch { ShowError("Не удалось изменить автозапуск."); }
            });
            try
            {
                autostart.SetEnabled(true);
                startWithWindows.Checked = autostart.IsEnabled;
                diagnostics.Write(startWithWindows.Checked ? "autostart_ready" : "autostart_disabled");
            }
            catch { startWithWindows.Checked = false; }

            MenuItem micTest = new MenuItem("Проверить микрофон", delegate { Forget(MicrophoneTestAsync()); });
            MenuItem restart = new MenuItem("Перезапустить backend", delegate { Forget(RestartBackendAsync()); });
            MenuItem exit = new MenuItem("Выход", delegate { Forget(ExitAsync()); });
            ContextMenu menu = new ContextMenu(new[] {
                open,
                new MenuItem("-"),
                voicePause,
                startWithWindows,
                micTest,
                restart,
                new MenuItem("-"),
                exit
            });

            tray = new NotifyIcon();
            tray.Text = "JARVIS Voice";
            tray.Icon = SystemIcons.Application;
            tray.ContextMenu = menu;
            tray.Visible = true;
            tray.DoubleClick += delegate { Forget(OpenJarvisAsync()); };

            stopSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.StopEventName);
            openSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.OpenEventName);
            stopWait = ThreadPool.RegisterWaitForSingleObject(stopSignal, delegate(object state, bool timeout)
            {
                synchronizationContext.Post(delegate { Forget(ExitAsync()); }, null);
            }, null, Timeout.Infinite, false);
            openWait = ThreadPool.RegisterWaitForSingleObject(openSignal, delegate(object state, bool timeout)
            {
                synchronizationContext.Post(delegate { Forget(OpenJarvisAsync()); }, null);
            }, null, Timeout.Infinite, false);

            pttTimer = new System.Windows.Forms.Timer();
            pttTimer.Interval = 20;
            pttTimer.Tick += delegate { HandleAction(ptt.Tick(clock.ElapsedMilliseconds)); };
            pttTimer.Start();

            try { keyboard = new GlobalKeyboardHook(OnKeyboard, synchronizationContext); }
            catch (Exception) { ShowError("Глобальный Right Ctrl недоступен."); }

            Forget(StartAsync());
        }

        private async Task StartAsync()
        {
            try
            {
                await backend.EnsureRunningAsync();
                diagnostics.Write("backend_ready");
                overlay.ShowState("JARVIS готов", "Удерживайте правый Ctrl, чтобы говорить.", Color.FromArgb(91, 202, 147), false, 2200);
                if (openOnStart) await OpenJarvisAsync();
            }
            catch { diagnostics.Write("backend_start_failed"); ShowError("Backend не запустился. Проверьте, свободен ли порт 3210."); }
        }

        private void OnKeyboard(KeyboardInput input)
        {
            if (paused)
            {
                if (input.VirtualKey == PttStateMachine.VK_ESCAPE) CancelRecording();
                return;
            }
            PttAction action = input.IsDown
                ? ptt.KeyDown(input.VirtualKey, input.Injected, clock.ElapsedMilliseconds)
                : ptt.KeyUp(input.VirtualKey, input.Injected, clock.ElapsedMilliseconds);
            HandleAction(action);
            if (!input.IsDown && input.VirtualKey == PttStateMachine.VK_RCONTROL && action == PttAction.None)
                activeTrace = null;
        }

        private void HandleAction(PttAction action)
        {
            if (action == PttAction.Armed)
            {
                activeTrace = new PttLatencyTrace();
                activeTrace.Mark(0);
            }
            else if (action == PttAction.StartRecording) StartRecording();
            else if (action == PttAction.StopRecording)
            {
                PttLatencyTrace trace = activeTrace ?? new PttLatencyTrace();
                activeTrace = null;
                trace.Mark(2);
                Forget(StopAndProcessAsync(trace));
            }
            else if (action == PttAction.CancelRecording) CancelRecording();
        }

        private void StartRecording()
        {
            if (recorder != null || paused) return;
            overlay.BeginSession();
            try
            {
                recorder = new WaveInRecorder();
                recorder.Start();
                if (activeTrace != null) activeTrace.Mark(1);
                overlay.ShowState("Слушаю", "Отпустите правый Ctrl для отправки. Esc — отмена.", Color.FromArgb(102, 170, 255), true, 0);
            }
            catch
            {
                if (recorder != null) recorder.Dispose();
                recorder = null;
                ShowError("Микрофон недоступен.");
            }
        }

        private async Task StopAndProcessAsync(PttLatencyTrace trace)
        {
            WaveInRecorder active = recorder;
            recorder = null;
            if (active == null) return;
            overlay.ShowState("Обрабатываю", "Завершаю локальную запись.", Color.FromArgb(102, 170, 255), true, 0);
            AudioRecording audio;
            try { audio = await Task.Run(delegate { return active.Stop(); }); }
            catch { active.Dispose(); trace.Write(diagnostics, "recording_failed"); ShowError("Не удалось завершить запись."); return; }
            active.Dispose();
            trace.Mark(3);
            trace.Mark(4);

            if (audio.DurationMs < MinimumRecordingMs)
            {
                overlay.ShowState("Слишком коротко", "Удерживайте правый Ctrl чуть дольше.", Color.FromArgb(151, 158, 166), false, 1800);
                return;
            }

            try
            {
                await backend.EnsureRunningAsync();
                overlay.ShowState("Распознаю", "Речь обрабатывается локально.", Color.FromArgb(102, 170, 255), true, 0);
                trace.Mark(5);
                Dictionary<string, object> transcription = await backend.Api.TranscribeAsync(audio.WavBytes);
                Dictionary<string, object> transcriptionTimings = HostApiClient.GetObject(transcription, "timings");
                long asrStarted = HostApiClient.GetLong(transcriptionTimings, "asrStartedAtUnixMs");
                long transcriptReady = HostApiClient.GetLong(transcriptionTimings, "transcriptReadyAtUnixMs");
                if (asrStarted > 0) trace.Mark(5, asrStarted);
                trace.Mark(6, transcriptReady > 0 ? transcriptReady : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                trace.ModelLoadMs = HostApiClient.GetLong(transcriptionTimings, "modelLoadMs");
                trace.AsrMs = HostApiClient.GetLong(transcriptionTimings, "asrMs");
                trace.Warm = HostApiClient.GetBool(transcriptionTimings, "warm");
                string transcript = HostApiClient.GetString(transcription, "text");
                if (string.IsNullOrWhiteSpace(transcript))
                {
                    trace.Write(diagnostics, "empty_transcript");
                    overlay.ShowState("Ничего не услышал", "Попробуйте ещё раз чуть ближе к микрофону.", Color.FromArgb(151, 158, 166), false, 2200);
                    return;
                }

                overlay.ShowState("Выполняю", transcript, Color.FromArgb(102, 170, 255), true, 0);
                trace.Mark(7);
                Dictionary<string, object> accepted = await backend.Api.SubmitAsync(transcript);
                Dictionary<string, object> routingTimings = HostApiClient.GetObject(accepted, "timings");
                long routedAt = HostApiClient.GetLong(routingTimings, "routedAtUnixMs");
                long acceptedAt = HostApiClient.GetLong(routingTimings, "acceptedAtUnixMs");
                long turnStartedAt = HostApiClient.GetLong(routingTimings, "turnStartedAtUnixMs");
                if (routedAt > 0) trace.Mark(7, routedAt);
                trace.Mark(8, acceptedAt > 0 ? acceptedAt : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                if (turnStartedAt > 0) trace.Mark(9, turnStartedAt);
                trace.Write(diagnostics, "accepted");
                string initialState = HostApiClient.GetString(accepted, "state");
                string kind = HostApiClient.GetString(accepted, "kind");
                if (string.Equals(kind, "approval-conflict", StringComparison.OrdinalIgnoreCase))
                {
                    overlay.ShowState("Нужно выбрать действие", "Открыто несколько подтверждений. Завершите одно из них в JARVIS.", Color.FromArgb(231, 166, 79), false, 0);
                    return;
                }
                if (string.Equals(kind, "approval-pending", StringComparison.OrdinalIgnoreCase))
                    overlay.ShowState("Не понял подтверждение", "Скажите «да» или «нет».", Color.FromArgb(231, 166, 79), false, 0);
                if (string.Equals(initialState, "blocked", StringComparison.OrdinalIgnoreCase))
                {
                    overlay.ShowState("Заблокировано", "Опасная системная операция не будет выполнена.", Color.FromArgb(231, 105, 105), false, 5000);
                    return;
                }
                string commandId = HostApiClient.GetString(accepted, "commandId");
                await PollCommandAsync(commandId, transcript);
            }
            catch (HostApiException error)
            {
                trace.Write(diagnostics, "host_api_failed");
                if (error.StatusCode == HttpStatusCode.Unauthorized)
                    overlay.ShowState("Нужен вход", "Откройте Codex и войдите в ChatGPT, затем повторите.", Color.FromArgb(231, 166, 79), false, 6000);
                else ShowError("JARVIS не смог обработать голосовую команду.");
            }
            catch { trace.Write(diagnostics, "failed"); ShowError("JARVIS не смог обработать голосовую команду."); }
        }

        private async Task PollCommandAsync(string commandId, string transcript)
        {
            if (string.IsNullOrEmpty(commandId)) throw new InvalidOperationException("Voice command id is missing.");
            string previous = string.Empty;
            for (int attempt = 0; attempt < 1200; attempt++)
            {
                Dictionary<string, object> command = await backend.Api.CommandStatusAsync(commandId);
                string state = HostApiClient.GetString(command, "state") ?? "executing";
                if (!string.Equals(previous, state, StringComparison.OrdinalIgnoreCase))
                {
                    previous = state;
                    if (state == "queued") overlay.ShowState("В очереди", transcript, Color.FromArgb(151, 158, 166), true, 0);
                    else if (state == "executing") overlay.ShowState("Выполняю", transcript, Color.FromArgb(102, 170, 255), true, 0);
                    else if (state == "confirming") overlay.ShowState("Подтверждено", "Исходное действие продолжается.", Color.FromArgb(91, 202, 147), true, 0);
                    else if (state == "approval")
                    {
                        Dictionary<string, object> snapshot = await backend.Api.StatusAsync();
                        Dictionary<string, object> approval = HostApiClient.GetObject(snapshot, "pendingApproval");
                        string target = HostApiClient.GetString(approval, "target") ?? "точное действие указано в JARVIS";
                        overlay.ShowState("Нужно подтверждение", target + "\r\nСкажите «да» или «нет» правым Ctrl.", Color.FromArgb(231, 166, 79), false, 0);
                    }
                }

                if (state == "success")
                {
                    Dictionary<string, object> display = HostApiClient.GetObject(command, "display");
                    string displayType = HostApiClient.GetString(display, "type") ?? "action-success";
                    string displayText = HostApiClient.GetString(display, "text") ?? transcript;
                    bool truncated = HostApiClient.GetBool(display, "truncated");
                    if (string.Equals(displayType, "answer", StringComparison.OrdinalIgnoreCase))
                        overlay.ShowAnswer(displayText, truncated);
                    else if (string.Equals(displayType, "action-success", StringComparison.OrdinalIgnoreCase))
                        overlay.ShowActionSuccess(displayText);
                    else
                        overlay.ShowState("Готово", displayText, Color.FromArgb(91, 202, 147), false, 3200);
                    return;
                }
                if (state == "blocked")
                {
                    overlay.ShowState("Заблокировано", "Опасная системная операция не будет выполнена.", Color.FromArgb(231, 105, 105), false, 5000);
                    return;
                }
                if (state == "auth-required")
                {
                    overlay.ShowState("Нужен вход", "Откройте Codex и войдите в ChatGPT, затем повторите.", Color.FromArgb(231, 166, 79), false, 6000);
                    return;
                }
                if (state == "error")
                {
                    ShowError("Команда завершилась с ошибкой.");
                    return;
                }
                await Task.Delay(500);
            }
            ShowError("Команда выполняется слишком долго.");
        }

        private void CancelRecording()
        {
            WaveInRecorder active = recorder;
            recorder = null;
            ptt.Reset();
            activeTrace = null;
            if (active != null)
            {
                Forget(Task.Run(delegate { active.Cancel(); active.Dispose(); }));
                overlay.ShowState("Отменено", "Запись удалена и не отправлена.", Color.FromArgb(151, 158, 166), false, 1400);
            }
        }

        private async Task SetPauseAsync(bool value)
        {
            try
            {
                await backend.EnsureRunningAsync();
                await backend.Api.PauseAsync(value);
                overlay.ShowState(value ? "Голос на паузе" : "Голос включён", value ? "Right Ctrl временно отключён." : "Right Ctrl снова готов.", Color.FromArgb(151, 158, 166), false, 1800);
            }
            catch { ShowError("Не удалось изменить voice state."); }
        }

        private async Task MicrophoneTestAsync()
        {
            if (recorder != null) return;
            WaveInRecorder test = new WaveInRecorder();
            try
            {
                overlay.ShowState("Проверяю микрофон", "Короткая локальная запись не будет отправлена.", Color.FromArgb(102, 170, 255), true, 0);
                test.Start();
                await Task.Delay(800);
                AudioRecording recording = await Task.Run(delegate { return test.Stop(); });
                overlay.ShowState("Микрофон работает", recording.DurationMs >= 500 ? "Локальная запись успешно получена." : "Запись получена, но оказалась короткой.", Color.FromArgb(91, 202, 147), false, 2400);
            }
            catch { ShowError("Микрофон недоступен."); }
            finally { test.Dispose(); }
        }

        private async Task RestartBackendAsync()
        {
            try
            {
                overlay.ShowState("Перезапускаю", "Только принадлежащий JARVIS backend.", Color.FromArgb(102, 170, 255), true, 0);
                await backend.RestartAsync();
                diagnostics.Write("backend_restart_ready");
                overlay.ShowState("Backend готов", "Голосовые команды снова доступны.", Color.FromArgb(91, 202, 147), false, 2200);
            }
            catch { diagnostics.Write("backend_restart_failed"); ShowError("Backend не удалось перезапустить."); }
        }

        private async Task OpenJarvisAsync()
        {
            try
            {
                await backend.EnsureRunningAsync();
                ProcessStartInfo info = new ProcessStartInfo("http://127.0.0.1:3210");
                info.UseShellExecute = true;
                Process.Start(info);
            }
            catch
            {
                diagnostics.Write("backend_start_failed");
                ShowError("Backend не запустился. Проверьте, свободен ли порт 3210.");
            }
        }

        private void ShowError(string message)
        {
            overlay.ShowState("Ошибка", message, Color.FromArgb(231, 105, 105), false, 5000);
        }

        private static void Forget(Task task)
        {
            if (task == null) return;
            task.ContinueWith(delegate(Task failed) { var ignored = failed.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
        }

        private async Task ExitAsync()
        {
            if (exiting) return;
            exiting = true;
            diagnostics.Write("host_stopping");
            CancelRecording();
            tray.Visible = false;
            try { await backend.StopOwnedAsync(); } catch { }
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (keyboard != null) keyboard.Dispose();
                pttTimer.Stop();
                pttTimer.Dispose();
                stopWait.Unregister(null);
                openWait.Unregister(null);
                stopSignal.Dispose();
                openSignal.Dispose();
                tray.Visible = false;
                tray.Dispose();
                overlay.Dispose();
                backend.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
