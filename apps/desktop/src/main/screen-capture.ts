import { app, desktopCapturer, Menu, type BrowserWindow } from "electron";
import { isAllowedNavigation } from "./nav-guard";
import { APP_INDEX } from "./protocol";

/** getDisplayMedia has no built-in source picker on Windows Electron. */
export function installScreenCapture(win: BrowserWindow): void {
  win.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.frame || request.frame !== win.webContents.mainFrame ||
        !isAllowedNavigation(request.frame.url, APP_INDEX) || !request.userGesture) {
      callback({});
      return;
    }
    const frame = request.frame;
    const chinese = app.getLocale().startsWith("zh");
    let sources: Electron.DesktopCapturerSource[];
    try {
      sources = await desktopCapturer.getSources({
        types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 },
      });
    } catch (error) {
      // Reject the browser request so the recorder displays its access error.
      console.error("Unable to list recording sources", error);
      if (!frame.detached) callback({});
      return;
    }
    if (win.isDestroyed() || frame.detached) return;
    if (sources.length === 0) {
      callback({});
      return;
    }
    let answered = false;
    const menu = Menu.buildFromTemplate([
      { label: chinese ? "选择要录制的屏幕或窗口" : "Choose a screen or window to record", enabled: false },
      { type: "separator" },
      ...sources.map((source) => ({
        label: source.name.replaceAll("&", "&&"),
        click: () => {
          answered = true;
          if (frame.detached) return;
          callback({
            video: source,
            ...(request.audioRequested && process.platform === "win32" ? { audio: "loopback" } : {}),
          });
        },
      })),
      { type: "separator" },
      { label: chinese ? "取消" : "Cancel" },
    ]);
    menu.popup({ window: win, callback: () => {
      if (!answered && !frame.detached) callback({});
    } });
  }, { useSystemPicker: true });
}
