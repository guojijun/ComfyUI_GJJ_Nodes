import { api } from "/scripts/api.js";

// Crystools sends high-frequency monitor packets. Some ComfyUI builds log
// websocket message types with no frontend listener as "Unhandled message".
// Registering this listener keeps the console clean without changing Crystools.
api.addEventListener("crystools.monitor", () => {});
