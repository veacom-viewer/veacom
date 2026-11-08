// The desktop regression preloads this to fail one reading after the viewer switches to SUL.
const validation = require('../../tools/lib/pet-validation.cjs');
const parse = validation.parseSphereValues;
validation.parseSphereValues = text => {
  if (text.startsWith('SUL max ')) {
    validation.parseSphereValues = parse;
    throw new Error('Synthetic SUL read failure');
  }
  return parse(text);
};
