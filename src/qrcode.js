// Compact, self-contained QR Code generator for WiiUltraConnect
// Generates clean SVG markup without external dependencies

function createQRCodeMatrix(text) {
  // Simple Type 1 to 4 QR code or binary matrix representation
  // For standard strings like session code or connection URL
  const length = text.length;
  // Use a reliable compact QR encoder implementation
  return generateSimpleQR(text);
}

// Minimalist Reed-Solomon QR encoder for short alphanumeric/byte strings
function generateSimpleQR(data) {
  // Generate a standard SVG QR Code
  const qr = QRCodeModel(0, 1); // Auto version, Low/Medium EC
  qr.addData(data);
  qr.make();
  return qr;
}

// Tiny QR library core
function QRCodeModel(typeNumber, errorCorrectLevel) {
  const PAD0 = 0xEC;
  const PAD1 = 0x11;
  let modules = null;
  let moduleCount = 0;
  let dataList = [];

  function make() {
    typeNumber = typeNumber || getTypeNumber();
    moduleCount = typeNumber * 4 + 17;
    modules = Array.from({ length: moduleCount }, () => Array(moduleCount).fill(null));
    setupPositionProbePattern(0, 0);
    setupPositionProbePattern(moduleCount - 7, 0);
    setupPositionProbePattern(0, moduleCount - 7);
    setupPositionAdjustPattern();
    setupTimingPattern();
    setupTypeInfo(false, 0);
    if (typeNumber >= 7) setupTypeNumber(false);
    mapData(createData(typeNumber, errorCorrectLevel, dataList), 0);
  }

  function getTypeNumber() {
    const length = dataList.reduce((acc, d) => acc + d.getLength(), 0);
    if (length <= 14) return 1;
    if (length <= 26) return 2;
    if (length <= 42) return 3;
    if (length <= 62) return 4;
    if (length <= 84) return 5;
    if (length <= 106) return 6;
    return 7;
  }

  function setupPositionProbePattern(row, col) {
    for (let r = -1; r <= 7; r++) {
      if (row + r <= -1 || moduleCount <= row + r) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c <= -1 || moduleCount <= col + c) continue;
        if ((0 <= r && r <= 6 && (c === 0 || c === 6)) ||
            (0 <= c && c <= 6 && (r === 0 || r === 6)) ||
            (2 <= r && r <= 4 && 2 <= c && c <= 4)) {
          modules[row + r][col + c] = true;
        } else {
          modules[row + r][col + c] = false;
        }
      }
    }
  }

  function setupTimingPattern() {
    for (let r = 8; r < moduleCount - 8; r++) {
      if (modules[r][6] != null) continue;
      modules[r][6] = (r % 2 === 0);
    }
    for (let c = 8; c < moduleCount - 8; c++) {
      if (modules[6][c] != null) continue;
      modules[6][c] = (c % 2 === 0);
    }
  }

  function setupPositionAdjustPattern() {
    const pos = QRPattern[typeNumber] || [];
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        const row = pos[i];
        const col = pos[j];
        if (modules[row][col] != null) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            if (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)) {
              modules[row + r][col + c] = true;
            } else {
              modules[row + r][col + c] = false;
            }
          }
        }
      }
    }
  }

  function setupTypeInfo(test, maskPattern) {
    const data = (errorCorrectLevel << 3) | maskPattern;
    const bits = getBCHTypeInfo(data);
    for (let i = 0; i < 15; i++) {
      const mod = (!test && ((bits >> i) & 1) === 1);
      if (i < 6) modules[i][8] = mod;
      else if (i < 8) modules[i + 1][8] = mod;
      else modules[moduleCount - 15 + i][8] = mod;

      if (i < 8) modules[8][moduleCount - i - 1] = mod;
      else if (i < 9) modules[8][15 - i - 1 + 1] = mod;
      else modules[8][15 - i - 1] = mod;
    }
    modules[moduleCount - 8][8] = !test;
  }

  function setupTypeNumber(test) {
    const bits = getBCHTypeNumber(typeNumber);
    for (let i = 0; i < 18; i++) {
      const mod = (!test && ((bits >> i) & 1) === 1);
      modules[Math.floor(i / 3)][i % 3 + moduleCount - 8 - 3] = mod;
      modules[i % 3 + moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
    }
  }

  function mapData(data, maskPattern) {
    let inc = -1;
    let row = moduleCount - 1;
    let bitIndex = 7;
    let byteIndex = 0;

    for (let col = moduleCount - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      while (true) {
        for (let c = 0; c < 2; c++) {
          if (modules[row][col - c] == null) {
            let dark = false;
            if (byteIndex < data.length) {
              dark = (((data[byteIndex] >>> bitIndex) & 1) === 1);
            }
            const mask = ((row + (col - c)) % 2 === 0);
            if (mask) dark = !dark;
            modules[row][col - c] = dark;
            bitIndex--;
            if (bitIndex === -1) {
              byteIndex++;
              bitIndex = 7;
            }
          }
        }
        row += inc;
        if (row < 0 || moduleCount <= row) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  }

  return {
    addData(data) { dataList.push(QR8BitByte(data)); },
    make,
    getModuleCount() { return moduleCount; },
    isDark(row, col) { return modules[row][col] || false; },
    toSVG(size = 200) {
      const count = moduleCount;
      const margin = 4;
      const total = count + margin * 2;
      let path = '';
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (modules[r][c]) {
            path += `M${c + margin},${r + margin}h1v1h-1z `;
          }
        }
      }
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges">
        <rect width="100%" height="100%" fill="#ffffff" rx="8"/>
        <path d="${path}" fill="#0f172a"/>
      </svg>`;
    }
  };
}

function QR8BitByte(data) {
  const bytes = new TextEncoder().encode(data);
  return {
    getLength() { return bytes.length; },
    write(buffer) {
      buffer.put(4, 4); // 8-bit byte mode
      buffer.put(bytes.length, 8);
      for (let i = 0; i < bytes.length; i++) buffer.put(bytes[i], 8);
    }
  };
}

const QRPattern = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38]
];

const QRRSBlock = {
  1: [1, 26, 19],
  2: [1, 44, 34],
  3: [1, 70, 55],
  4: [1, 100, 80],
  5: [1, 134, 108],
  6: [2, 86, 68],
  7: [2, 98, 78]
};

function createData(typeNumber, errorCorrectLevel, dataList) {
  const rsBlock = QRRSBlock[typeNumber] || QRRSBlock[4];
  const buffer = QRBitBuffer();
  for (let i = 0; i < dataList.length; i++) dataList[i].write(buffer);

  const totalDataCount = rsBlock[0] * rsBlock[2];
  if (buffer.getLengthInBits() > totalDataCount * 8) {
    throw new Error('Data overflow');
  }

  if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) buffer.put(0, 4);
  while (buffer.getLengthInBits() % 8 !== 0) buffer.putBit(false);

  while (true) {
    if (buffer.getLengthInBits() >= totalDataCount * 8) break;
    buffer.put(0xEC, 8);
    if (buffer.getLengthInBits() >= totalDataCount * 8) break;
    buffer.put(0x11, 8);
  }

  return createBytes(buffer, rsBlock);
}

function createBytes(buffer, rsBlock) {
  const totalCodeCount = rsBlock[1];
  const dataCount = rsBlock[2];
  const ecCount = totalCodeCount - dataCount;
  const rsPoly = QRPolynomial([1], 0);
  for (let i = 0; i < ecCount; i++) {
    rsPoly.multiply(QRPolynomial([1, QRMath.gexp(i)], 0));
  }

  const rawBytes = buffer.getBuffer();
  const rawData = [];
  for (let i = 0; i < dataCount; i++) rawData.push(rawBytes[i] || 0);

  const rawPoly = QRPolynomial(rawData, ecCount);
  const modPoly = rawPoly.mod(rsPoly);
  const ecData = [];
  for (let i = 0; i < ecCount; i++) {
    const modIndex = i + modPoly.getLength() - ecCount;
    ecData.push(modIndex >= 0 ? modPoly.get(modIndex) : 0);
  }

  return rawData.concat(ecData);
}

function QRBitBuffer() {
  const buffer = [];
  let length = 0;
  return {
    getBuffer() { return buffer; },
    getLengthInBits() { return length; },
    put(num, len) {
      for (let i = 0; i < len; i++) {
        this.putBit(((num >>> (len - i - 1)) & 1) === 1);
      }
    },
    putBit(bit) {
      const bufIndex = Math.floor(length / 8);
      if (buffer.length <= bufIndex) buffer.push(0);
      if (bit) buffer[bufIndex] |= (0x80 >>> (length % 8));
      length++;
    }
  };
}

const QRMath = {
  glog(n) {
    if (n < 1) throw new Error('glog(' + n + ')');
    return QRMath.LOG_TABLE[n];
  },
  gexp(n) {
    while (n < 0) n += 255;
    while (n >= 256) n -= 255;
    return QRMath.EXP_TABLE[n];
  },
  EXP_TABLE: new Array(256),
  LOG_TABLE: new Array(256)
};

for (let i = 0; i < 8; i++) QRMath.EXP_TABLE[i] = 1 << i;
for (let i = 8; i < 256; i++) QRMath.EXP_TABLE[i] = QRMath.EXP_TABLE[i - 4] ^ QRMath.EXP_TABLE[i - 5] ^ QRMath.EXP_TABLE[i - 6] ^ QRMath.EXP_TABLE[i - 8];
for (let i = 0; i < 255; i++) QRMath.LOG_TABLE[QRMath.EXP_TABLE[i]] = i;

function QRPolynomial(num, shift) {
  let offset = 0;
  while (offset < num.length && num[offset] === 0) offset++;
  const numCopy = num.slice(offset);
  for (let i = 0; i < shift; i++) numCopy.push(0);

  return {
    get(index) { return numCopy[index]; },
    getLength() { return numCopy.length; },
    multiply(e) {
      const result = new Array(this.getLength() + e.getLength() - 1).fill(0);
      for (let i = 0; i < this.getLength(); i++) {
        for (let j = 0; j < e.getLength(); j++) {
          result[i + j] ^= QRMath.gexp(QRMath.glog(this.get(i)) + QRMath.glog(e.get(j)));
        }
      }
      return QRPolynomial(result, 0);
    },
    mod(e) {
      if (this.getLength() - e.getLength() < 0) return this;
      const ratio = QRMath.glog(this.get(0)) - QRMath.glog(e.get(0));
      const result = numCopy.slice();
      for (let i = 0; i < e.getLength(); i++) {
        result[i] ^= QRMath.gexp(QRMath.glog(e.get(i)) + ratio);
      }
      return QRPolynomial(result, 0).mod(e);
    }
  };
}

function getBCHTypeInfo(data) {
  let d = data << 10;
  while (getBCHDigit(d) - getBCHDigit(0x537) >= 0) {
    d ^= (0x537 << (getBCHDigit(d) - getBCHDigit(0x537)));
  }
  return ((data << 10) | d) ^ 0x5465;
}

function getBCHTypeNumber(data) {
  let d = data << 12;
  while (getBCHDigit(d) - getBCHDigit(0x1F25) >= 0) {
    d ^= (0x1F25 << (getBCHDigit(d) - getBCHDigit(0x1F25)));
  }
  return (data << 12) | d;
}

function getBCHDigit(data) {
  let digit = 0;
  while (data !== 0) {
    digit++;
    data >>>= 1;
  }
  return digit;
}

export function renderQRCodeSVG(text, size = 180) {
  try {
    const qr = QRCodeModel(0, 1);
    qr.addData(text);
    qr.make();
    return qr.toSVG(size);
  } catch (err) {
    console.error('QR code generation error:', err);
    return null;
  }
}
