const express = require("express");
const path = require("path");

const app = express();

app.use(express.json({ limit: "45mb" }));
app.use(express.static(path.join(__dirname, "public")));

const TOKEN = process.env.VERCEL_TOKEN;
const TEAM_ID = process.env.VERCEL_TEAM_ID || "";
const PORT = process.env.PORT || 3000;

function apiUrl(endpoint) {
  return "https://api.vercel.com" + endpoint +
    (TEAM_ID ? (endpoint.includes("?") ? "&" : "?") +
    "teamId=" + encodeURIComponent(TEAM_ID) : "");
}

async function vercel(endpoint, options = {}) {
  const response = await fetch(apiUrl(endpoint), {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = { message: text };
  }

  if (!response.ok) {
    throw new Error(
      data.error?.message || data.message ||
      `Vercel API error: ${response.status}`
    );
  }

  return data;
}

function cleanName(value) {
  return String(value || "z-project")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 52) || "z-project";
}

function validateFiles(files) {
  if (!Array.isArray(files) || !files.length) {
    throw new Error("No project files received.");
  }

  if (files.length > 500) {
    throw new Error("Maximum 500 files per deployment.");
  }

  let totalSize = 0;

  for (const item of files) {
    if (!item.file || typeof item.data !== "string") {
      throw new Error("Invalid file data.");
    }

    const filePath = item.file.replace(/\\/g, "/");

    if (
      filePath.startsWith("/") ||
      filePath.split("/").includes("..") ||
      filePath.includes("\0")
    ) {
      throw new Error("Invalid file path.");
    }

    totalSize += Buffer.from(item.data, "base64").length;
  }

  if (totalSize > 30 * 1024 * 1024) {
    throw new Error("Project is larger than 30 MB.");
  }

  if (!files.some(f => f.file.split("/").pop() === "index.html")) {
    throw new Error("index.html must be in the project root.");
  }
}

async function getOrCreateProject(name) {
  try {
    return await vercel("/v9/projects/" + encodeURIComponent(name));
  } catch (error) {
    const project = await vercel("/v10/projects", {
      method: "POST",
      body: JSON.stringify({
        name,
        framework: null
      })
    });
    return project;
  }
}

app.post("/api/deploy", async (req, res) => {
  try {
    if (!TOKEN) {
      return res.status(500).json({
        error: "VERCEL_TOKEN is not configured on the server."
      });
    }

    const files = req.body.files;
    validateFiles(files);

    const name = cleanName(req.body.name);
    const project = await getOrCreateProject(name);
    const projectId = project.id;

    if (!projectId) {
      throw new Error("Could not identify the Vercel project.");
    }

    const deployment = await vercel(
      "/v13/deployments?skipAutoDetectionConfirmation=1",
      {
        method: "POST",
        body: JSON.stringify({
          name,
          project: projectId,
          target: "production",
          files,
          projectSettings: {
            framework: null
          }
        })
      }
    );

    if (!deployment.id || !deployment.url) {
      throw new Error("Vercel did not create a deployment.");
    }

    const deploymentId = deployment.id;
    let state = deployment.readyState;
    let latest = deployment;

    for (let i = 0; i < 60; i++) {
      if (state === "READY") break;

      if (state === "ERROR" || state === "CANCELED") {
        throw new Error("Vercel deployment failed: " + state);
      }

      await new Promise(resolve => setTimeout(resolve, 3000));

      latest = await vercel(
        "/v13/deployments/" + encodeURIComponent(deploymentId)
      );

      state = latest.readyState;
    }

    if (state !== "READY") {
      return res.status(202).json({
        error: "Deployment is still processing. Try again later.",
        deploymentId
      });
    }

    const url = "https://" + latest.url;

    res.json({
      success: true,
      url,
      deploymentId
    });

  } catch (error) {
    console.error("Deployment error:", error);
    res.status(500).json({
      error: error.message || "Deployment failed."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Z Platform running on port ${PORT}`);
});

