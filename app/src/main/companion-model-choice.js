'use strict';
const { supportsImages } = require('./llm');

// Keep the conversation model independent of the model used for screen images.
function chooseVisionModel(provider, models, requested, conversation) {
  const available = (Array.isArray(models) ? models : []).filter(name => typeof name === 'string' && supportsImages(provider, name));
  if (available.includes(requested)) return requested;
  if (available.includes(conversation)) return conversation;
  return available[0] || null;
}

module.exports = { chooseVisionModel };
