import { handleHealthRequest } from "./_health.mjs";

export default {
  fetch(request) {
    return handleHealthRequest(request);
  },
};
