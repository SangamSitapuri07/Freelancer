import crypto from "node:crypto";
import os from "node:os";
import machineId from "node-machine-id";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

function getHwid() {
  const override = arg("hwid", "");
  if (override) return override;

  try {
    return machineId.machineIdSync({ original: true });
  } catch {
    return crypto
      .createHash("sha256")
      .update(
        [
          os.hostname(),
          os.platform(),
          os.arch(),
          os.cpus()[0]?.model || "",
          String(os.totalmem()),
        ].join("|"),
      )
      .digest("hex");
  }
}

async function main() {
  const base = arg("base", "http://localhost:8080").replace(/\/+$/, "");
  const licenseKey = arg("license", "");
  const deviceName = arg("device", "Demo Device");
  const hwid = getHwid();

  if (!licenseKey) {
    console.error("Usage: node scripts/demo-client.mjs --license GG-XXXX-XXXX-XXXX-XXXX");
    console.error("Optional: --base http://localhost:8080 --device \"My PC\" --hwid DEVICE_ID");
    process.exit(1);
  }

  console.log(`GhostGate demo client`);
  console.log(`Server: ${base}`);
  console.log(`Device: ${deviceName}`);
  console.log(`HWID:   ${hwid}`);
  console.log("");

  const activateResponse = await fetch(`${base}/v1/licenses/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ licenseKey, hwid, deviceName }),
  });

  const activateText = await activateResponse.text();
  let activateData;
  try {
    activateData = JSON.parse(activateText);
  } catch {
    activateData = { raw: activateText };
  }

  if (!activateResponse.ok) {
    console.error("Activation failed:", activateResponse.status, activateData);
    process.exit(1);
  }

  const sessionToken = activateData.sessionToken;
  console.log("Activation successful.");
  console.log(`License:  ${activateData.license.keyMasked}`);
  console.log(`Credits:  ${activateData.license.creditsRemaining} remaining`);
  console.log(`Expires:  ${activateData.license.expiresAt}`);
  console.log(`Device:   ${activateData.device.hwidDisplay}`);
  console.log("");

  const heartbeatResponse = await fetch(`${base}/v1/license/heartbeat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  const heartbeat = await heartbeatResponse.json();
  console.log(
    `Heartbeat: ${heartbeatResponse.status} · ${heartbeat.license?.creditsRemaining ?? "?"} credits remaining`,
  );
  console.log("");

  const aiResponse = await fetch(`${base}/v1/ai/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      messages: [
        {
          role: "user",
          content:
            "Write a concise JavaScript function that reverses a string. Return only the function.",
        },
      ],
      maxTokens: 300,
    }),
  });

  const aiText = await aiResponse.text();
  let aiData;
  try {
    aiData = JSON.parse(aiText);
  } catch {
    aiData = { raw: aiText };
  }

  if (!aiResponse.ok) {
    console.error("AI request failed:", aiResponse.status, aiData);
    console.error(
      "If this is a 503, set AI_API_KEY in .env and restart the server. The demo client never sees the key.",
    );
    process.exit(1);
  }

  console.log("AI completion:");
  console.log(aiData.content);
  console.log("");
  console.log(
    `Credits used: ${aiData.creditsUsed} · remaining: ${aiData.creditsRemaining} · tokens: ${aiData.usage?.totalTokens ?? "?"}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
