import Runtime from "pear-electron";
import Bridge from "pear-bridge";
import subprocess from "bare-subprocess";
import env from "bare-env";
import path from "bare-path";

const bridge = new Bridge({ waypoint: "index.html" });
await bridge.ready();

const apiPort = "38471";
const node = env.NODE || "node";
const projectDir = Pear.config.dir || ".";
const storageRoot = Pear.config.storage || path.join(projectDir, ".qvac-mesh-workspace");
const backend = subprocess.spawn(node, ["dist/src/backendServer.js"], {
  cwd: projectDir,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...env,
    QVAC_MESH_API_PORT: apiPort,
    QVAC_MESH_STORAGE: storageRoot
  }
});

backend.stdout.on("data", (data) => console.log(data.toString()));
backend.stderr.on("data", (data) => console.error(data.toString()));

const runtime = new Runtime();
const pipe = await runtime.start({ bridge });

Pear.teardown(() => {
  pipe.end();
  backend.kill("SIGTERM");
});

pipe.on("close", () => Pear.exit());
