import { handleTriageRequest } from "./_ai-triage.mjs";

export default {
  fetch(request) {
    return handleTriageRequest(request);
  },
};
