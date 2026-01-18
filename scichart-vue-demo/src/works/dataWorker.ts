// dataWorker.ts

/**
 * LTTB 下采样算法
 */
function lttbDownsample(
  data: [number, number][],
  threshold: number
): [number, number][] {
  if (data.length <= threshold) return data.slice();

  const sampled: [number, number][] = [];
  const bucketSize = (data.length - 2) / (threshold - 2);

  sampled.push(data[0]!);
  let a = 0;

  for (let i = 1; i < threshold - 1; i++) {
    let avgX = 0,
      avgY = 0;
    const start = Math.floor((i - 1) * bucketSize) + 1;
    const end = Math.min(Math.floor(i * bucketSize) + 1, data.length - 1);
    let count = 0;

    for (let j = start; j < end; j++) {
      const pt = data[j];
      if (!pt) continue;
      avgX += pt[0];
      avgY += pt[1];
      count++;
    }

    const avg: [number, number] =
      count > 0 ? [avgX / count, avgY / count] : data[a] ?? [0, 0];

    let maxArea = -1;
    let nextA = start;

    const pa = data[a] ?? [0, 0];
    for (let j = start; j < end; j++) {
      const pj = data[j];
      if (!pj) continue;
      const area =
        Math.abs(
          (pa[0] - avg[0]) * (pj[1] - pa[1]) -
            (pa[0] - pj[0]) * (avg[1] - pa[1])
        ) / 2;
      if (area > maxArea) {
        maxArea = area;
        nextA = j;
      }
    }

    const chosen = data[nextA] ?? pa;
    sampled.push(chosen);
    a = nextA;
  }

  sampled.push(data[data.length - 1]!);
  return sampled;
}

/**
 * 生成正向 Y 轴模拟数据
 */
function generateSimulatedData(size: number): [number, number][] {
  const data: [number, number][] = [];
  for (let i = 0; i < size; i++) {
    const x = i;
    // 确保 Y 轴始终为正：Math.abs + 基础偏移
    const y = Math.abs(Math.sin(i / 1000) * 50) + Math.random() * 15 + 10;
    data.push([x, y]);
  }
  return data;
}

// 优化后的发送函数：使用 Transferable Objects 零拷贝传输
function sendBuffer(data: [number, number][]) {
  const count = data.length;
  const xArray = new Float32Array(count);
  const yArray = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const v = data[i]!;
    xArray[i] = v[0];
    yArray[i] = v[1];
  }

  // 这里的第二个参数 [xArray.buffer, yArray.buffer] 确保了数据的零拷贝传输
  (self as any).postMessage({ xArray, yArray, count }, [
    xArray.buffer,
    yArray.buffer,
  ]);
}

self.onmessage = async function (event: MessageEvent<any>) {
  const {
    action,
    url,
    dataSize = 1000000,
    samplePoints,
    startRatio,
    endRatio,
  } = event.data;

  try {
    if (action === "generateData" || action === "processData") {
      let data: [number, number][];
      if (action === "generateData") {
        data = generateSimulatedData(dataSize);
      } else {
        const response = await fetch(url!);
        data = await response.json();
      }
      (self as any).fullData = data;

      // 初次加载：发送极简预览
      sendBuffer(lttbDownsample(data, samplePoints));
      return;
    }

    const fullData = (self as any).fullData;
    if (!fullData) return;

    if (action === "resetToPreview") {
      // 明确回到全览，发送预览数据
      const previewPoints = samplePoints ?? 1000;
      const preview = lttbDownsample(fullData, previewPoints);
      sendBuffer(preview);
      return;
    }

    if (action === "resample") {
      const startIdx = Math.floor((startRatio ?? 0) * fullData.length);
      const endIdx = Math.floor((endRatio ?? 1) * fullData.length);
      const subset = fullData.slice(startIdx, endIdx);

      const result =
        subset.length <= samplePoints
          ? subset
          : lttbDownsample(subset, samplePoints);
      sendBuffer(result);
    }
  } catch (error: any) {
    (self as any).postMessage({ error: error.message });
  }
};
