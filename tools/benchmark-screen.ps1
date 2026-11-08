# Read the pixels the Windows desktop displays, including shared-texture overlays.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class BenchmarkScreen {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    public static void Run() {
        SetProcessDPIAware();
        using (var bitmap = new Bitmap(96, 96, PixelFormat.Format32bppArgb))
        using (var graphics = Graphics.FromImage(bitmap)) {
            var bytes = new byte[96 * 96 * 4];
            Console.WriteLine("ready");
            string line;
            while ((line = Console.ReadLine()) != null) {
                var point = line.Split(' ');
                graphics.CopyFromScreen(int.Parse(point[0]), int.Parse(point[1]), 0, 0, bitmap.Size);
                var data = bitmap.LockBits(new Rectangle(0, 0, 96, 96), ImageLockMode.ReadOnly, bitmap.PixelFormat);
                try { Marshal.Copy(data.Scan0, bytes, 0, bytes.Length); }
                finally { bitmap.UnlockBits(data); }
                byte low = 255, high = 0;
                for (int i = 0; i < bytes.Length; i += 4) {
                    low = Math.Min(low, bytes[i]);
                    high = Math.Max(high, bytes[i]);
                }
                Console.WriteLine(low + " " + high);
            }
        }
    }
}
'@
[BenchmarkScreen]::Run()
