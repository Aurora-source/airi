using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

// Captures the primary display for the Companion Core perception service.
// The frame stays in memory. It is downscaled and encoded here, then written to stdout once and never saved.
public static class CompanionScreenCapture
{
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

    private const uint DesktopSwitchDesktop = 0x0100;
    private static ImageCodecInfo jpegCodec;

    public static void Initialize()
    {
        // Physical pixels, so a scaled desktop is captured whole.
        SetProcessDPIAware();
        foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders())
        {
            if (codec.MimeType == "image/jpeg")
                jpegCodec = codec;
        }
    }

    public static string Capture(int maxWidth, int quality)
    {
        // A locked or secure desktop is never copied. Node reports it as a privacy block.
        if (IsLocked())
            return "{\"ok\":false,\"error\":\"locked\"}";
        Screen screen = Screen.PrimaryScreen;
        Rectangle bounds = screen.Bounds;
        string app;
        string title;
        string windowId;
        ReadForeground(out app, out title, out windowId);
        int width = Math.Min(maxWidth, bounds.Width);
        int height = Math.Max(1, (int)Math.Round((double)bounds.Height * width / bounds.Width));
        long capturedAt;
        byte[] jpeg;
        byte[] samples;
        using (Bitmap full = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb))
        {
            using (Graphics graphics = Graphics.FromImage(full))
                graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
            capturedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            using (Bitmap scaled = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                using (Graphics graphics = Graphics.FromImage(scaled))
                {
                    graphics.InterpolationMode = InterpolationMode.Bilinear;
                    graphics.DrawImage(full, 0, 0, width, height);
                }
                samples = Sample(scaled);
                using (MemoryStream stream = new MemoryStream())
                {
                    EncoderParameters parameters = new EncoderParameters(1);
                    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                    scaled.Save(stream, jpegCodec, parameters);
                    jpeg = stream.ToArray();
                }
            }
        }

        StringBuilder json = new StringBuilder();
        json.Append("{\"ok\":true,\"capturedAt\":").Append(capturedAt);
        json.Append(",\"display\":").Append(Quote(screen.DeviceName + "|" + bounds.Width + "x" + bounds.Height + "@" + bounds.X + "," + bounds.Y));
        json.Append(",\"width\":").Append(width).Append(",\"height\":").Append(height);
        json.Append(",\"locked\":false");
        if (app != null)
            json.Append(",\"app\":").Append(Quote(app));
        if (title != null)
            json.Append(",\"title\":").Append(Quote(title));
        if (windowId != null)
            json.Append(",\"windowId\":").Append(Quote(windowId));
        json.Append(",\"samples\":\"").Append(Convert.ToBase64String(samples)).Append('"');
        json.Append(",\"jpeg\":\"").Append(Convert.ToBase64String(jpeg)).Append("\"}");
        return json.ToString();
    }

    // The same 64 by 36 grid as sampleLuminance in Companion Core: four points per cell, BT.601 weights.
    private static byte[] Sample(Bitmap bitmap)
    {
        byte[] output = new byte[2304];
        int width = bitmap.Width;
        int height = bitmap.Height;
        BitmapData data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            double[] offsets = new double[] { 0.25, 0.75 };
            for (int y = 0; y < 36; y++)
            {
                for (int x = 0; x < 64; x++)
                {
                    double total = 0;
                    foreach (double dy in offsets)
                    {
                        foreach (double dx in offsets)
                        {
                            int row = Math.Min(height - 1, (int)Math.Floor((y + dy) * height / 36));
                            int column = Math.Min(width - 1, (int)Math.Floor((x + dx) * width / 64));
                            int index = row * data.Stride + column * 4;
                            int blue = Marshal.ReadByte(data.Scan0, index);
                            int green = Marshal.ReadByte(data.Scan0, index + 1);
                            int red = Marshal.ReadByte(data.Scan0, index + 2);
                            total += (red * 77 + green * 150 + blue * 29) / 256.0;
                        }
                    }
                    output[y * 64 + x] = (byte)Math.Round(total / 4, MidpointRounding.AwayFromZero);
                }
            }
        }
        finally
        {
            bitmap.UnlockBits(data);
        }
        return output;
    }

    // A locked workstation or a secure desktop refuses the input desktop. That counts as locked.
    private static bool IsLocked()
    {
        IntPtr desktop = OpenInputDesktop(0, false, DesktopSwitchDesktop);
        if (desktop == IntPtr.Zero)
            return true;
        CloseDesktop(desktop);
        return false;
    }

    private static void ReadForeground(out string app, out string title, out string windowId)
    {
        app = null;
        title = null;
        windowId = null;
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero)
            return;
        windowId = window.ToInt64().ToString("x");
        StringBuilder text = new StringBuilder(512);
        if (GetWindowText(window, text, text.Capacity) > 0)
            title = text.ToString();
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        try
        {
            app = Process.GetProcessById((int)processId).ProcessName;
        }
        catch (ArgumentException)
        {
            app = null;
        }
        catch (InvalidOperationException)
        {
            app = null;
        }
    }

    // ASCII-only JSON strings, so the console code page cannot change the bytes.
    private static string Quote(string value)
    {
        StringBuilder output = new StringBuilder("\"");
        foreach (char character in value)
        {
            if (character == '"' || character == '\\')
                output.Append('\\').Append(character);
            else if (character < 32 || character > 126)
                output.Append(string.Format("\\u{0:x4}", (int)character));
            else
                output.Append(character);
        }
        return output.Append('"').ToString();
    }
}
