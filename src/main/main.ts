import { app, BrowserWindow, shell, ipcMain, clipboard } from "electron";
import path from "path";
import { getDb } from "./database/db.js";
import { SecretStore } from "./secret-store/secrets.js";
import { registerHandlers } from "./ipc/handlers.js";

const dataDir =
  process.env["FORGE_DATA_DIR"] ?? app.getPath("userData");

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0d0d0f",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "../../preload/preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
    show: false,
  });

  // Load renderer
  if (process.env["NODE_ENV"] === "development") {
    void mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(
      path.join(__dirname, "../../renderer/index.html")
    );
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const database = getDb(dataDir);
  const secrets = new SecretStore(dataDir);

  // Clipboard write — renderer can't use navigator.clipboard reliably in Electron
  ipcMain.handle("clipboard:write", (_event, text: string) => {
    clipboard.writeText(text);
  });

  registerHandlers({ secrets, database });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});