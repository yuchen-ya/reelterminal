import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { launchApp, type LaunchedApp } from "./harness/launch";

describe.skipIf(process.platform !== "win32")("Windows title bar hit regions", () => {
  let launched: LaunchedApp;
  afterAll(async () => { await launched?.close(); });

  test("treats both blank title bar areas as native caption while keeping controls clickable", async () => {
    launched = await launchApp();
    const page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/ }).click();
    const points = await page.locator("header").first().evaluate(header => {
      const center = header.children[1].getBoundingClientRect();
      const actions = header.querySelector('a[href*="github.com"]')!.getBoundingClientRect();
      const rect = header.getBoundingClientRect();
      const scale = devicePixelRatio;
      return [
        { x: center.left - 30, y: rect.y + rect.height / 2 },
        { x: (center.right + actions.left) / 2, y: rect.y + rect.height / 2 },
        { x: actions.x + actions.width / 2, y: actions.y + actions.height / 2 },
        { x: center.x + center.width / 2, y: center.y + center.height / 2 },
      ].map(point => ({ x: Math.round(point.x * scale), y: Math.round(point.y * scale) }));
    });
    const hwnd = await launched.app.evaluate(({ BrowserWindow }) => {
      const handle = BrowserWindow.getAllWindows()[0].getNativeWindowHandle();
      return handle.readBigUInt64LE().toString();
    });
    // Ask Windows/Electron's actual non-client hit test, rather than only
    // checking a CSS property or simulating DOM mouse events (which cannot drag a window).
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CaptionProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[CaptionProbe]::SetProcessDPIAware() | Out-Null
$windowHandle = [IntPtr]::new(${hwnd})
${points.map(point => `
$point = New-Object CaptionProbe+Point
$point.X = ${point.x}; $point.Y = ${point.y}
[CaptionProbe]::ClientToScreen($windowHandle, [ref]$point) | Out-Null
$packed = (($point.Y -band 65535) -shl 16) -bor ($point.X -band 65535)
[CaptionProbe]::SendMessage($windowHandle, 132, [IntPtr]::Zero, [IntPtr]::new($packed)).ToInt32()
`).join("")}`;
    const hits = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 }).trim().split(/\s+/).map(Number);
    expect(hits).toEqual([2, 2, 1, 1]); // HTCAPTION, HTCAPTION, HTCLIENT, HTCLIENT
    await page.getByRole("button", { name: /Settings|设置/, exact: true }).click();
    await page.getByRole("dialog").waitFor();
  }, 60_000);
});
