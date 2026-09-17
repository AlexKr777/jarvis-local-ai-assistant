using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace JarvisVoiceHost
{
    internal enum PttAction
    {
        None,
        Armed,
        StartRecording,
        StopRecording,
        CancelRecording
    }

    internal sealed class PttStateMachine
    {
        internal const int VK_ESCAPE = 0x1B;
        internal const int VK_LCONTROL = 0xA2;
        internal const int VK_RCONTROL = 0xA3;
        internal const long HoldThresholdMs = 180;
        internal const long MaximumRecordingMs = 55000;

        private bool rightControlDown;
        private bool armed;
        private bool recording;
        private long pressedAt;
        private long recordingAt;

        internal bool IsRecording { get { return recording; } }

        internal PttAction KeyDown(int virtualKey, bool injected, long nowMs)
        {
            if (injected) return PttAction.None;
            if (virtualKey == VK_ESCAPE && (armed || recording))
            {
                Reset();
                return PttAction.CancelRecording;
            }
            if (virtualKey == VK_RCONTROL)
            {
                if (rightControlDown) return PttAction.None;
                rightControlDown = true;
                armed = true;
                pressedAt = nowMs;
                return PttAction.Armed;
            }
            if (armed && !recording)
            {
                Reset();
                return PttAction.CancelRecording;
            }
            return PttAction.None;
        }

        internal PttAction KeyUp(int virtualKey, bool injected, long nowMs)
        {
            if (injected || virtualKey != VK_RCONTROL) return PttAction.None;
            if (!rightControlDown) return PttAction.None;
            rightControlDown = false;
            if (recording)
            {
                recording = false;
                armed = false;
                return PttAction.StopRecording;
            }
            armed = false;
            return PttAction.None;
        }

        internal PttAction Tick(long nowMs)
        {
            if (armed && rightControlDown && !recording && nowMs - pressedAt >= HoldThresholdMs)
            {
                recording = true;
                recordingAt = nowMs;
                return PttAction.StartRecording;
            }
            if (recording && nowMs - recordingAt >= MaximumRecordingMs)
            {
                Reset();
                return PttAction.StopRecording;
            }
            return PttAction.None;
        }

        internal void Reset()
        {
            rightControlDown = false;
            armed = false;
            recording = false;
            pressedAt = 0;
            recordingAt = 0;
        }
    }

    internal sealed class KeyboardInput
    {
        internal int VirtualKey;
        internal bool IsDown;
        internal bool Injected;
    }

    internal sealed class GlobalKeyboardHook : IDisposable
    {
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_KEYUP = 0x0101;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int WM_SYSKEYUP = 0x0105;
        private const uint LLKHF_INJECTED = 0x00000010;

        private readonly LowLevelKeyboardProc callback;
        private readonly Action<KeyboardInput> listener;
        private readonly SynchronizationContext synchronizationContext;
        private IntPtr hook;

        internal GlobalKeyboardHook(Action<KeyboardInput> listener, SynchronizationContext synchronizationContext)
        {
            if (listener == null) throw new ArgumentNullException("listener");
            this.listener = listener;
            this.synchronizationContext = synchronizationContext ?? new SynchronizationContext();
            callback = HookCallback;
            using (Process process = Process.GetCurrentProcess())
            using (ProcessModule module = process.MainModule)
            {
                IntPtr moduleHandle = GetModuleHandle(module.ModuleName);
                hook = SetWindowsHookEx(WH_KEYBOARD_LL, callback, moduleHandle, 0);
            }
            if (hook == IntPtr.Zero) throw new InvalidOperationException("Global Right Ctrl hook could not be installed.");
        }

        private IntPtr HookCallback(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0)
            {
                int message = wParam.ToInt32();
                bool isDown = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
                bool isUp = message == WM_KEYUP || message == WM_SYSKEYUP;
                if (isDown || isUp)
                {
                    KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    KeyboardInput input = new KeyboardInput();
                    input.VirtualKey = unchecked((int)data.vkCode);
                    input.IsDown = isDown;
                    input.Injected = (data.flags & LLKHF_INJECTED) != 0;
                    synchronizationContext.Post(delegate(object ignored) { listener(input); }, null);
                }
            }
            return CallNextHookEx(hook, code, wParam, lParam);
        }

        public void Dispose()
        {
            if (hook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(hook);
                hook = IntPtr.Zero;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            internal uint vkCode;
            internal uint scanCode;
            internal uint flags;
            internal uint time;
            internal UIntPtr dwExtraInfo;
        }

        private delegate IntPtr LowLevelKeyboardProc(int code, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc callback, IntPtr module, uint threadId);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hook);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string moduleName);
    }

    internal sealed class GlobalMouseDownObserver : IDisposable
    {
        private const int WH_MOUSE_LL = 14;
        private const int WM_LBUTTONDOWN = 0x0201;
        private const int WM_RBUTTONDOWN = 0x0204;
        private const int WM_MBUTTONDOWN = 0x0207;
        private const int WM_XBUTTONDOWN = 0x020B;

        private readonly LowLevelMouseProc callback;
        private readonly Action listener;
        private readonly SynchronizationContext synchronizationContext;
        private IntPtr hook;

        internal GlobalMouseDownObserver(Action listener, SynchronizationContext synchronizationContext)
        {
            if (listener == null) throw new ArgumentNullException("listener");
            this.listener = listener;
            this.synchronizationContext = synchronizationContext ?? new SynchronizationContext();
            callback = HookCallback;
        }

        internal bool Enabled { get { return hook != IntPtr.Zero; } }

        internal void Enable()
        {
            if (hook != IntPtr.Zero) return;
            using (Process process = Process.GetCurrentProcess())
            using (ProcessModule module = process.MainModule)
            {
                IntPtr moduleHandle = GetModuleHandle(module.ModuleName);
                hook = SetWindowsHookEx(WH_MOUSE_LL, callback, moduleHandle, 0);
            }
            if (hook == IntPtr.Zero) throw new InvalidOperationException("Global answer-dismiss observer could not be installed.");
        }

        internal void Disable()
        {
            IntPtr active = hook;
            hook = IntPtr.Zero;
            if (active != IntPtr.Zero) UnhookWindowsHookEx(active);
        }

        private IntPtr HookCallback(int code, IntPtr wParam, IntPtr lParam)
        {
            IntPtr active = hook;
            int message = wParam.ToInt32();
            if (code >= 0 && (message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN
                || message == WM_MBUTTONDOWN || message == WM_XBUTTONDOWN))
            {
                Disable();
                synchronizationContext.Post(delegate(object ignored) { listener(); }, null);
            }
            return CallNextHookEx(active, code, wParam, lParam);
        }

        public void Dispose() { Disable(); }

        private delegate IntPtr LowLevelMouseProc(int code, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc callback, IntPtr module, uint threadId);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hook);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string moduleName);
    }
}
