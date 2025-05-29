const express = require("express");
const multer = require("multer");
const fs = require("fs");
const { exec } = require("child_process");
const path = require("path");
const { execSync } = require("child_process");

const app = express();
const PORT = 3000;
const CONFIG_PATH = "./config.json";

// Ensure uploads directory exists
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

// Configure multer for large files
const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    fieldSize: 10 * 1024 * 1024, // 10MB field size limit
    fields: 10, // Maximum number of non-file fields
    files: 1, // Maximum number of file fields
  },
});

// Increase JSON payload limit and add error handling
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static("public"));

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`📥 ${new Date().toISOString()} - ${req.method} ${req.url}`);
  console.log("Headers:", req.headers);
  next();
});

// Add error handling middleware
app.use((err, req, res, next) => {
  console.error("❌ Error:", err);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      status: "error",
      message: `Upload error: ${err.message}`,
      code: "UPLOAD_ERROR",
    });
  }
  res.status(500).json({
    status: "error",
    message: "Internal server error",
    code: "SERVER_ERROR",
  });
});

let persistentConfig = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    if (typeof loaded.dryRun === "boolean")
      persistentConfig.dryRun = loaded.dryRun;
    if (typeof loaded.defaultPrinter === "string")
      persistentConfig.defaultPrinter = loaded.defaultPrinter;
  } catch (e) {
    console.error("Failed to load config.json, using default dryRun: true");
  }
}

app.get("/config", (req, res) => {
  res.json({
    dryRun: persistentConfig.dryRun,
    defaultPrinter: persistentConfig.defaultPrinter,
  });
});

app.post("/config", (req, res) => {
  console.log("/config POST received:", JSON.stringify(req.body, null, 2));
  // Only update dryRun if present
  if (typeof req.body.dryRun !== "undefined") {
    let val = req.body.dryRun;
    if (typeof val === "string") val = val === "true";
    persistentConfig.dryRun = val;
  }
  // Update or clear defaultPrinter
  if (typeof req.body.defaultPrinter !== "undefined") {
    if (req.body.defaultPrinter && req.body.defaultPrinter !== "") {
      persistentConfig.defaultPrinter = req.body.defaultPrinter;
    } else {
      delete persistentConfig.defaultPrinter;
    }
  }
  // Apply printer options to CUPS if present
  if (req.body.printer && req.body.printerOptions) {
    const optionsEntries = Object.entries(req.body.printerOptions);
    if (optionsEntries.length === 0) {
      console.warn("printerOptions is empty; nothing to apply to CUPS");
    } else {
      const optionsStr = optionsEntries
        .map(([key, value]) => `-o ${key}=${value}`)
        .join(" ");
      const cmd = `lpoptions -p ${req.body.printer} ${optionsStr}`;
      console.log("Running lpoptions command:", cmd);
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error("Failed to set printer options in CUPS:", err, stderr);
          fs.writeFileSync(
            CONFIG_PATH,
            JSON.stringify(persistentConfig, null, 2)
          );
          return res.status(500).json({
            status: "error",
            message: "Failed to set printer options in CUPS",
            dryRun: persistentConfig.dryRun,
            defaultPrinter: persistentConfig.defaultPrinter,
            stderr: stderr,
          });
        }
        console.log("lpoptions stdout:", stdout);
        fs.writeFileSync(
          CONFIG_PATH,
          JSON.stringify(persistentConfig, null, 2)
        );
        res.json({
          status: "ok",
          dryRun: persistentConfig.dryRun,
          defaultPrinter: persistentConfig.defaultPrinter,
        });
      });
      return;
    }
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(persistentConfig, null, 2));
  res.json({
    status: "ok",
    dryRun: persistentConfig.dryRun,
    defaultPrinter: persistentConfig.defaultPrinter,
  });
});

app.get("/printers", (req, res) => {
  exec("lpstat -p | awk '{print $2}'", (err, stdout) => {
    if (err) return res.status(500).send("Error listing printers");
    const printers = stdout.trim().split("\n");
    res.json({ printers });
  });
});

app.post("/print/image", upload.single("photo"), (req, res) => {
  console.log("🧾 Incoming /print/image request body:", req.body);

  let filePath;

  // Handle both multipart form data and JSON requests
  if (req.file) {
    // Handle file upload
    filePath = path.resolve(req.file.path);
    console.log("📷 Photo uploaded:", filePath);
  } else if (req.body && req.body.image) {
    // Handle base64 image
    try {
      const filename = `print_${Date.now()}.jpg`;
      filePath = path.join("uploads", filename);
      const base64Data = req.body.image.replace(/^data:image\/\w+;base64,/, "");
      const imageBuffer = Buffer.from(base64Data, "base64");
      fs.writeFileSync(filePath, imageBuffer);
      console.log("📷 Image saved:", filePath);
    } catch (error) {
      console.error("❌ Error processing base64 image:", error);
      return res.status(400).json({
        status: false,
        error: "Error processing image data",
        human_error: "Error processing image data",
        data: null,
      });
    }
  } else {
    console.warn("⚠️ No image data provided");
    return res.status(400).json({
      status: false,
      error: "No image data provided",
      human_error: "No image data provided",
      data: null,
    });
  }

  let printerFlag = "";
  if (persistentConfig.defaultPrinter) {
    printerFlag = `-d ${persistentConfig.defaultPrinter}`;
  }

  // Advanced printer options from form
  let advancedFlags = "";
  if (req.body) {
    Object.entries(req.body).forEach(([key, value]) => {
      if (key.startsWith("printerOption_")) {
        const optName = key.replace("printerOption_", "");
        advancedFlags += ` -o ${optName}=${value}`;
      }
    });
  }

  // Handle number_of_copies or copies
  let copiesFlag = "";
  if (req.body.number_of_copies || req.body.copies) {
    const copies = req.body.number_of_copies || req.body.copies;
    if (!isNaN(Number(copies)) && Number(copies) > 0) {
      copiesFlag = ` -n ${Number(copies)}`;
    }
  }

  if (persistentConfig.dryRun) {
    console.log(
      "🖨️ [DRY RUN] Would execute print command:",
      `lp ${printerFlag}${copiesFlag}${advancedFlags} "${filePath}"`
    );
    fs.unlink(filePath, () => {});
    return res.status(200).json({
      status: true,
      error: null,
      human_error: null,
      data: null,
    });
  }

  const cmd = `lp ${printerFlag}${copiesFlag}${advancedFlags} "${filePath}"`;
  console.log("🖨️ Executing print command:", cmd);

  exec(cmd, (err, stdout, stderr) => {
    fs.unlink(filePath, () => {});
    if (err) {
      console.error("❌ Print error:", stderr.trim());
      return res.status(500).json({
        status: false,
        error: stderr.trim(),
        human_error: "Print failed",
        data: null,
      });
    }
    console.log("✅ Print success:", stdout.trim());
    res.status(200).json({
      status: true,
      error: null,
      human_error: null,
      data: null,
    });
  });
});

// Endpoint to get printer options
app.get("/printer-options", (req, res) => {
  const printer = req.query.printer;
  if (!printer)
    return res.status(400).json({ error: "Missing printer parameter" });
  // Get current default options
  let currentOptionsMap = {};
  let markerMessage = null;
  try {
    const currentOptions = execSync(`lpoptions -p ${printer}`).toString();
    currentOptions.split(/\s+/).forEach((pair) => {
      const [key, value] = pair.split("=");
      if (key && value) {
        currentOptionsMap[key.trim().toLowerCase()] = value.trim();
        if (key.trim().toLowerCase() === "marker-message") {
          markerMessage = value.trim();
        }
      }
    });
  } catch (e) {
    // Ignore if fails, just means no defaults set
  }
  console.log("[printer-options] currentOptionsMap:", currentOptionsMap);
  exec(`lpoptions -l -p ${printer}`, (err, stdout) => {
    if (err)
      return res.status(500).json({ error: "Error fetching printer options" });
    // Parse lpoptions output
    const options = {};
    stdout.split("\n").forEach((line) => {
      if (!line.trim()) return;
      // Example: Media/Media Size: *Custom.WIDTHxHEIGHTmm 4x6 2x6
      const match = line.match(/^(\w+)(?:\/(.*?))?:\s+(.+)$/);
      if (match) {
        const key = match[1];
        const label = match[2] || key;
        const keyNorm = key.toLowerCase();
        console.log(
          `[printer-options] Parsing key: '${key}' (normalized: '${keyNorm}')`
        );
        const values = match[3].split(/\s+/).map((v) => {
          const value = v.replace(/^\*/, "");
          return {
            value: value,
            default:
              v.startsWith("*") ||
              value.toLowerCase() ===
                (currentOptionsMap[keyNorm] || "").toLowerCase(),
          };
        });
        options[key] = { label, values };
      }
    });
    res.json({ ...options, markerMessage });
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Snappic print server listening at http://0.0.0.0:${PORT}`);
  console.log(`Also available at http://raspberrypi.local:${PORT}`);
});
