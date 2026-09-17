using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace JarvisVoiceHost
{
    internal sealed class AudioRecording
    {
        internal byte[] WavBytes;
        internal long DurationMs;
    }

    internal sealed class WaveInRecorder : IDisposable
    {
        private const uint WAVE_MAPPER = 0xFFFFFFFF;
        private const uint CALLBACK_EVENT = 0x00050000;
        private const int SampleRate = 16000;
        private const int Channels = 1;
        private const int BitsPerSample = 16;
        private const int MaximumSeconds = 60;

        private AutoResetEvent returned;
        private IntPtr waveIn;
        private IntPtr dataBuffer;
        private IntPtr headerBuffer;
        private int capacity;
        private bool started;

        internal void Start()
        {
            if (started) throw new InvalidOperationException("Microphone recording is already active.");
            capacity = SampleRate * Channels * (BitsPerSample / 8) * MaximumSeconds;
            dataBuffer = Marshal.AllocHGlobal(capacity);
            headerBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WAVEHDR)));
            returned = new AutoResetEvent(false);

            WAVEFORMATEX format = new WAVEFORMATEX();
            format.wFormatTag = 1;
            format.nChannels = Channels;
            format.nSamplesPerSec = SampleRate;
            format.wBitsPerSample = BitsPerSample;
            format.nBlockAlign = (ushort)(Channels * BitsPerSample / 8);
            format.nAvgBytesPerSec = unchecked((uint)(SampleRate * format.nBlockAlign));
            format.cbSize = 0;

            try
            {
                Check(waveInOpen(
                    out waveIn,
                    WAVE_MAPPER,
                    ref format,
                    returned.SafeWaitHandle.DangerousGetHandle(),
                    IntPtr.Zero,
                    CALLBACK_EVENT), "waveInOpen");

                WAVEHDR header = new WAVEHDR();
                header.lpData = dataBuffer;
                header.dwBufferLength = unchecked((uint)capacity);
                header.dwBytesRecorded = 0;
                header.dwFlags = 0;
                Marshal.StructureToPtr(header, headerBuffer, false);
                Check(waveInPrepareHeader(waveIn, headerBuffer, unchecked((uint)Marshal.SizeOf(typeof(WAVEHDR)))), "waveInPrepareHeader");
                Check(waveInAddBuffer(waveIn, headerBuffer, unchecked((uint)Marshal.SizeOf(typeof(WAVEHDR)))), "waveInAddBuffer");
                Check(waveInStart(waveIn), "waveInStart");
                started = true;
            }
            catch
            {
                Cleanup();
                throw;
            }
        }

        internal AudioRecording Stop()
        {
            if (!started) return new AudioRecording { WavBytes = new byte[0], DurationMs = 0 };
            try
            {
                waveInStop(waveIn);
                waveInReset(waveIn);
                returned.WaitOne(2000);
                WAVEHDR header = (WAVEHDR)Marshal.PtrToStructure(headerBuffer, typeof(WAVEHDR));
                int bytesRecorded = unchecked((int)Math.Min(header.dwBytesRecorded, unchecked((uint)capacity)));
                byte[] pcm = new byte[bytesRecorded];
                if (bytesRecorded > 0) Marshal.Copy(dataBuffer, pcm, 0, bytesRecorded);
                return new AudioRecording
                {
                    WavBytes = CreateWav(pcm),
                    DurationMs = bytesRecorded * 1000L / (SampleRate * Channels * (BitsPerSample / 8))
                };
            }
            finally
            {
                Cleanup();
            }
        }

        internal void Cancel()
        {
            if (!started) return;
            Stop();
        }

        public void Dispose()
        {
            if (started) Cancel();
            Cleanup();
        }

        private void Cleanup()
        {
            if (waveIn != IntPtr.Zero)
            {
                if (headerBuffer != IntPtr.Zero)
                {
                    waveInUnprepareHeader(waveIn, headerBuffer, unchecked((uint)Marshal.SizeOf(typeof(WAVEHDR))));
                }
                waveInClose(waveIn);
                waveIn = IntPtr.Zero;
            }
            if (headerBuffer != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(headerBuffer);
                headerBuffer = IntPtr.Zero;
            }
            if (dataBuffer != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(dataBuffer);
                dataBuffer = IntPtr.Zero;
            }
            if (returned != null)
            {
                returned.Dispose();
                returned = null;
            }
            started = false;
        }

        private static byte[] CreateWav(byte[] pcm)
        {
            using (MemoryStream stream = new MemoryStream(44 + pcm.Length))
            using (BinaryWriter writer = new BinaryWriter(stream))
            {
                writer.Write(new[] { 'R', 'I', 'F', 'F' });
                writer.Write(36 + pcm.Length);
                writer.Write(new[] { 'W', 'A', 'V', 'E' });
                writer.Write(new[] { 'f', 'm', 't', ' ' });
                writer.Write(16);
                writer.Write((short)1);
                writer.Write((short)Channels);
                writer.Write(SampleRate);
                writer.Write(SampleRate * Channels * (BitsPerSample / 8));
                writer.Write((short)(Channels * BitsPerSample / 8));
                writer.Write((short)BitsPerSample);
                writer.Write(new[] { 'd', 'a', 't', 'a' });
                writer.Write(pcm.Length);
                writer.Write(pcm);
                writer.Flush();
                return stream.ToArray();
            }
        }

        private static void Check(uint result, string operation)
        {
            if (result != 0) throw new InvalidOperationException(operation + " failed with code " + result + ".");
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WAVEFORMATEX
        {
            internal ushort wFormatTag;
            internal ushort nChannels;
            internal uint nSamplesPerSec;
            internal uint nAvgBytesPerSec;
            internal ushort nBlockAlign;
            internal ushort wBitsPerSample;
            internal ushort cbSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WAVEHDR
        {
            internal IntPtr lpData;
            internal uint dwBufferLength;
            internal uint dwBytesRecorded;
            internal UIntPtr dwUser;
            internal uint dwFlags;
            internal uint dwLoops;
            internal IntPtr lpNext;
            internal UIntPtr reserved;
        }

        [DllImport("winmm.dll")]
        private static extern uint waveInOpen(out IntPtr handle, uint deviceId, ref WAVEFORMATEX format, IntPtr callback, IntPtr instance, uint flags);

        [DllImport("winmm.dll")]
        private static extern uint waveInPrepareHeader(IntPtr handle, IntPtr header, uint size);

        [DllImport("winmm.dll")]
        private static extern uint waveInAddBuffer(IntPtr handle, IntPtr header, uint size);

        [DllImport("winmm.dll")]
        private static extern uint waveInStart(IntPtr handle);

        [DllImport("winmm.dll")]
        private static extern uint waveInStop(IntPtr handle);

        [DllImport("winmm.dll")]
        private static extern uint waveInReset(IntPtr handle);

        [DllImport("winmm.dll")]
        private static extern uint waveInUnprepareHeader(IntPtr handle, IntPtr header, uint size);

        [DllImport("winmm.dll")]
        private static extern uint waveInClose(IntPtr handle);
    }
}
