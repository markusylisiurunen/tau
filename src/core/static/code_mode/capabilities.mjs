import "ses";

const NativeDate = Date;

export function createCodeModeDate() {
  const codeModeDate = function Date(...args) {
    if (!new.target) return Reflect.apply(NativeDate, undefined, args);
    return Reflect.construct(NativeDate, args, new.target);
  };
  Object.defineProperties(codeModeDate, {
    length: { value: NativeDate.length },
    now: { value: NativeDate.now },
    parse: { value: NativeDate.parse },
    UTC: { value: NativeDate.UTC },
  });
  codeModeDate.prototype = new NativeDate(Number.NaN);
  Object.defineProperty(codeModeDate.prototype, "constructor", {
    configurable: true,
    value: codeModeDate,
    writable: true,
  });
  return harden(codeModeDate);
}

export const codeModeMath = Math;
