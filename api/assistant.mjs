import { handleAssistantRequest } from "./_ai-assistant.mjs";

export default {
  fetch(request) {
    return handleAssistantRequest(request);
  },
};
