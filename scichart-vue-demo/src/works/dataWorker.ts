/**
 * 1. 基础类型定义
 */
type DataPoint = [number, number];

interface WorkerMessage {
  action:
    | "generateData"
    | "processData"
    | "resample"
    | "resetToPreview"
    | "resampleByTime";
  dataSize?: number;
  samplePoints: number;
  startRatio?: number;
  endRatio?: number;
  startTime?: number;
  endTime?: number;
}

/**
 * 2. 修正全局作用域类型
 * 使用联合类型确保 self 既有 DedicatedWorkerGlobalScope 的功能，又支持 postMessage 的转移属性
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

// 数据存储
let fullData: DataPoint[] = [];

/**
 * 3. LTTB 下采样算法
 * 解决了 DataPoint | undefined 报错
 */
function lttbDownsample(
  data: DataPoint[],
  threshold: number,
  start: number = 0,
  end: number = data.length,
): DataPoint[] {
  const dataLen = end - start;
  if (dataLen <= threshold || dataLen < 3) return data.slice(start, end);

  const sampled: DataPoint[] = [];
  const bucketSize = (dataLen - 2) / (threshold - 2);

  sampled.push(data[start]!);
  let a = start;

  for (let i = 1; i < threshold - 1; i++) {
    let avgX = 0,
      avgY = 0;
    const bucketStart = Math.floor((i - 1) * bucketSize) + 1 + start;
    const bucketEnd = Math.min(Math.floor(i * bucketSize) + 1 + start, end - 1);

    let count = 0;
    for (let j = bucketStart; j < bucketEnd; j++) {
      const pt = data[j]!;
      avgX += pt[0];
      avgY += pt[1];
      count++;
    }

    const pa = data[a]!;
    const avg: [number, number] =
      count > 0 ? [avgX / count, avgY / count] : [pa[0], pa[1]];

    let maxArea = -1;
    let nextA = bucketStart;

    for (let j = bucketStart; j < bucketEnd; j++) {
      const pj = data[j]!;
      const area =
        Math.abs(
          (pa[0] - avg[0]) * (pj[1] - pa[1]) -
            (pa[0] - pj[0]) * (avg[1] - pa[1]),
        ) * 0.5; // 使用 0.5 代替 /2

      if (area > maxArea) {
        maxArea = area;
        nextA = j;
      }
    }

    sampled.push(data[nextA]!);
    a = nextA;
  }

  sampled.push(data[end - 1]!);
  return sampled;
}

/**
 * 4. 高性能 Buffer 发送
 */
function sendBuffer(data: DataPoint[]) {
  const count = data.length;
  const xArray = new Float64Array(count); // 时间戳用 64 位
  const yArray = new Float32Array(count); // 数值用 32 位

  for (let i = 0; i < count; i++) {
    const pt = data[i]!;
    xArray[i] = pt[0];
    yArray[i] = pt[1];
  }

  // 转移权限以提升性能
  ctx.postMessage({ xArray, yArray, count, isSubChart: false }, [
    xArray.buffer,
    yArray.buffer,
  ]);
}

/**
 * 5. 辅助解析函数
 */
function processJsonLine(line: string, target: DataPoint[]) {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const obj = JSON.parse(trimmed);
    const t = obj.Time ?? obj.time;
    const v = obj.Value ?? obj.value;
    if (typeof t === "number" && typeof v === "number") {
      target.push([t, v]);
    }
  } catch {
    /* 忽略错误行 */
  }
}

/**
 * 6. 主监听逻辑
 */
ctx.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const { action, dataSize = 1000000, samplePoints = 1000 } = event.data;

  try {
    switch (action) {
      case "generateData":
        const newData: DataPoint[] = [];
        // 关键：取整秒，避免毫秒偏移导致间隔感官不对
        const baseTime = Math.floor(Date.now() / 1000) * 1000;

        for (let i = 0; i < dataSize; i++) {
          newData.push([
            baseTime + i * 1000, // 严格 1000ms (1s) 步进
            Math.abs(Math.sin(i / 100)) * 10 + Math.random() * 5,
          ]);
        }
        fullData = newData;
        // 初始预览依然需要下采样
        sendBuffer(lttbDownsample(fullData, samplePoints));
        break;

      case "processData":
        const response = await fetch(
          "http://localhost:5201/api/LargeData/stream",
        );
        if (!response.body) throw new Error("No body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const streamedData: DataPoint[] = [];
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) processJsonLine(line, streamedData);
        }
        if (buffer) processJsonLine(buffer, streamedData);

        fullData = streamedData;
        console.log("fullData", fullData);
        sendBuffer(lttbDownsample(fullData, samplePoints));
        break;

      case "resample":
        if (fullData.length === 0) return;
        // 这里的变量名不要与外层的重名，或者直接使用 event.data
        const rData = event.data;
        const sPoints = rData.samplePoints || 2000;

        let sIdx = Math.floor((rData.startRatio || 0) * fullData.length) - 2;
        let eIdx = Math.ceil((rData.endRatio || 1) * fullData.length) + 2;

        sIdx = Math.max(0, sIdx);
        eIdx = Math.min(fullData.length, eIdx);

        const actualCount = eIdx - sIdx;

        /**
         * 优化点：提高原数据切换阈值
         * 50,000 点既能保证 1:1 的还原度，又不会引起主线程卡顿
         */
        if (actualCount <= 50000) {
          sendBuffer(fullData.slice(sIdx, eIdx));
        } else {
          sendBuffer(lttbDownsample(fullData, sPoints, sIdx, eIdx));
        }
        break;

      case "resetToPreview":
        if (fullData.length > 0)
          sendBuffer(lttbDownsample(fullData, samplePoints));
        break;

      case "resampleByTime": {
        if (fullData.length === 0) return;
        const { startTime, endTime, samplePoints = 2000 } = event.data; // 新增：支持传入 samplePoints

        // 1. 定位索引
        const startIndex = Math.max(
          0,
          fullData.findIndex((p) => p[0] >= (startTime || 0)),
        );
        let endIndex = fullData.findIndex((p) => p[0] > (endTime || Infinity));
        if (endIndex === -1) endIndex = fullData.length;

        const rawSubSet = fullData.slice(startIndex, endIndex);

        // 2. 智能采样：50k 以内原数据，否则 LTTB（提高 threshold 到 20000）
        const finalResult =
          rawSubSet.length > 50000
            ? lttbDownsample(fullData, 5000, startIndex, endIndex) // 修改：20000 提高密度
            : rawSubSet;

        // 3. 发送 TypedArray
        const subX = new Float64Array(finalResult.length);
        const subY = new Float32Array(finalResult.length);
        for (let i = 0; i < finalResult.length; i++) {
          const pt = finalResult[i]!;
          subX[i] = pt[0];
          subY[i] = pt[1];
        }

        ctx.postMessage(
          {
            xArray: subX,
            yArray: subY,
            count: finalResult.length,
            isSubChart: true,
          },
          [subX.buffer, subY.buffer],
        );
        break;
      }
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    ctx.postMessage({ error: msg });
  }
};
