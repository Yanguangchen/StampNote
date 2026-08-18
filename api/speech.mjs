import { handleSpeechRequest } from "./_ai-speech.mjs";

export default {
  fetch(request) {
    return handleSpeechRequest(request);
  },
};
