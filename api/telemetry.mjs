import { handleTelemetryRequest } from "./_telemetry.mjs";

export default {
  fetch(request) {
    return handleTelemetryRequest(request);
  },
};
