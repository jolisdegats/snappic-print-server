const express = require("express");
const multer = require("multer");
const fs = require("fs");
const { exec } = require("child_process");
const path = require("path");

const app = express();
const PORT = 3000;
const CONFIG_PATH = "./config.json";

// Ensure uploads directory exists
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

let config = {
  printer: "",
  margins: { top: 0, right: 0, bottom: 0, left: 0 },
  transpose: false,
  paperSize: "4x6", // or '2x6'
  dryRun: false, // Add dry run mode
};

if (fs.existsSync(CONFIG_PATH)) {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
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

app.get("/config", (req, res) => {
  res.json(config);
});

app.post("/config", (req, res) => {
  config = req.body;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  res.json({ status: "saved" });
});

app.get("/printers", (req, res) => {
  exec("lpstat -p | awk '{print $2}'", (err, stdout) => {
    if (err) return res.status(500).send("Error listing printers");
    const printers = stdout.trim().split("\n");
    res.json({ printers });
  });
});

app.post("/print/image", upload.single("photo"), (req, res) => {
  console.log("🧾 Incoming /print/image request headers:", req.headers);
  console.log("🧾 Incoming /print/image request body:", req.body);
  console.log("📁 File info:", req.file);

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

  // Snappic app seems to always send strip prints
  const marginFlags = `-o page-top=${config.margins.top} -o page-bottom=${config.margins.bottom} -o page-left=${config.margins.left} -o page-right=${config.margins.right}`;
  const orientationFlag = config.transpose ? "-o landscape" : "";
  const printerFlag = config.printer ? `-d ${config.printer}` : "";
  const paperSizeFlag = "-o media=4x6 -o number-up=2"; // Always use 2x6 for strips

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

  // In dry run mode, we'll just simulate the print job
  if (config.dryRun) {
    console.log(
      "🖨️ [DRY RUN] Would execute print command:",
      `lp ${printerFlag} ${paperSizeFlag} ${marginFlags} ${orientationFlag}${advancedFlags} "${filePath}"`
    );

    // Clean up the file
    fs.unlink(filePath, () => {});

    // Send success response in the exact format expected
    return res.status(200).json({
      status: true,
      error: null,
      human_error: null,
      data: null,
    });
  }

  const cmd = `lp ${printerFlag} ${paperSizeFlag} ${marginFlags} ${orientationFlag}${advancedFlags} "${filePath}"`;
  console.log("🖨️ Executing print command:", cmd);

  exec(cmd, (err, stdout, stderr) => {
    // Clean up the file
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
    // Send success response in the exact format expected
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
        const values = match[3].split(/\s+/).map((v) => {
          return { value: v.replace(/^\*/, ""), default: v.startsWith("*") };
        });
        options[key] = { label, values };
      }
    });
    res.json(options);
  });
});

// Endpoint to get printer status and remaining prints
app.get("/printer-status", (req, res) => {
  const printer = config.printer || "QW410"; // Default to QW410 if no printer specified

  // Get detailed printer status using ipptool
  exec(
    `ipptool -tv ipp://localhost:631/printers/${printer} get-printer-attributes.test`,
    (err, ippStdout) => {
      if (err) {
        console.error("❌ Error getting IPP status:", err);
        // Fall back to CUPS status
        exec(`lpstat -p ${printer} -l`, (err, stdout) => {
          if (err) {
            console.error("❌ Error getting CUPS status:", err);
            return res.status(500).json({
              status: false,
              error: "Error getting printer status",
              human_error: "Printer is offline or not responding",
              data: null,
            });
          }

          res.json({
            status: true,
            error: null,
            human_error: null,
            data: {
              printer: printer,
              status: stdout.trim(),
              cups_status: stdout.trim(),
            },
          });
        });
        return;
      }

      // Parse IPP output
      const status = {
        printer: printer,
        ipp_status: ippStdout.trim(),
      };

      // Extract specific status information
      const lines = ippStdout.split("\n");
      lines.forEach((line) => {
        if (line.includes("marker-message")) {
          const match = line.match(
            /marker-message \(textWithoutLanguage\) = (.+)/
          );
          if (match) {
            status.remaining_prints_message = match[1];
          }
        }
        if (line.includes("printer-state")) {
          const match = line.match(/printer-state \(enum\) = (.+)/);
          if (match) {
            status.printer_state = match[1];
          }
        }
        if (line.includes("printer-state-message")) {
          const match = line.match(
            /printer-state-message \(textWithoutLanguage\) = (.+)/
          );
          if (match) {
            status.printer_state_message = match[1];
          }
        }
      });

      res.json({
        status: true,
        error: null,
        human_error: null,
        data: status,
      });
    }
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Snappic print server listening at http://0.0.0.0:${PORT}`);
  console.log(`Also available at http://raspberrypi.local:${PORT}`);
});
