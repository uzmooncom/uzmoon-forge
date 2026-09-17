import { app, BrowserWindow, shell } from "electron";
import path from "path";
import { getDb } from "./database/db.js";
import { SecretStore } from "./secret-store/secrets.js";
import { registerHandlers } from "./ipc/handlers.js";
import { sweepOrphanedSnapshots } from "./queue/QueueManager.js";
import { sweepWriteJournal } from "./project-files/edit-service.js";
import { initReliabilityEngine } from "./reliability/index.js";
import { RELIABILITY_IPC } from "../shared/types.js";

const dataDir =
  process.env["FORGE_DATA_DIR"] ?? app.getPath("userData");

let mainWindow: BrowserWindow | null = null;

function createWindow(secrets: SecretStore, database: true): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0d0d0f",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, "../../preload/preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
    show: false,
  });

  // Register IPC handlers now that we have webContents
  registerHandlers({ secrets, database }, mainWindow.webContents);

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

  // Sweep orphaned snapshot files from prior sessions (crash, failed enqueue, etc.)
  // DB must be initialised first so getAllMessages works.
  void database;
  try { sweepOrphanedSnapshots(); } catch { /* non-fatal */ }
  try { sweepWriteJournal(); } catch { /* non-fatal */ }

  // Initialize reliability subsystem (non-blocking; best-effort)
  try {
    initReliabilityEngine({
      dataDir,
      version: "0.9.0",
      notifyIncident: (incident) => {
        try {
          mainWindow?.webContents.send(RELIABILITY_IPC.INCIDENT_RECORDED, incident);
        } catch { /* non-fatal: window may be closing */ }
      },
    });
  } catch { /* non-fatal */ }

  createWindow(secrets, database);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(secrets, database);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});