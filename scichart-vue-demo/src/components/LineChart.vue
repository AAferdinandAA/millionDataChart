<template>
  <div class="chart-wrapper">
    <div v-if="loading" class="loading-overlay">加载数据中...</div>
    <div ref="chartRef" class="chart-container"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, shallowRef, onUnmounted } from "vue";
import * as echarts from "echarts";

const props = withDefaults(
  defineProps<{
    dataUrl?: string;
    dataSize?: number;
    samplePoints?: number;
  }>(),
  {
    dataSize: 5_000_000,
    samplePoints: 5_000,
  }
);

const chartRef = ref<HTMLDivElement | null>(null);
const loading = ref(true);

let myChart: echarts.ECharts | null = null;
let worker: Worker | null = null;
let throttleTimer: number | null = null;
let resizeTimer: number | null = null;

let resizeObserver: ResizeObserver | null = null;

// 节流 resize（避免过于频繁调用）
const resizeChart = () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (myChart && chartRef.value) {
      myChart.resize();
    }
  }, 100); // 100ms 节流
};

onMounted(() => {
  if (!chartRef.value) return;

  // 初始化图表
  myChart = echarts.init(chartRef.value, null, {
    renderer: "canvas",
  });

  // 基础配置（保持你原来的优化思路）
  myChart.setOption({
    title: { text: `大数据量折线图`, left: "center" },
    grid: {
      top: 40,
      right: 30,
      bottom: 60,
      left: 50,
      containLabel: true,
    },
    tooltip: {
      trigger: "axis",
      animation: false,
      confine: true,
      axisPointer: { type: "line" },
    },
    xAxis: {
      type: "value",
      min: 0,
      max: props.dataSize,
      silent: true,
    },
    yAxis: {
      type: "value",
      min: 0,
      silent: true,
    },
    dataZoom: [
      { type: "inside", filterMode: "none" },
      { type: "slider", filterMode: "none", realtime: false },
    ],
    series: [
      {
        type: "line",
        data: [],
        symbol: "none",
        sampling: "lttb",
        large: true,
        largeThreshold: 1000,
        progressive: 2000,
        lineStyle: { width: 1, join: "bevel" },
        animation: false,
        universalTransition: false,
      },
    ],
  });

  // 创建 Worker（保持原逻辑）
  worker = new Worker(new URL("../works/dataWorker.ts", import.meta.url), {
    type: "module",
  });

  worker.onmessage = (event) => {
    const { xArray, yArray, count, error } = event.data;
    if (error) return;

    const flatData = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      flatData[i * 2] = xArray[i];
      flatData[i * 2 + 1] = yArray[i];
    }

    const showSymbol = count < 500;

    myChart?.setOption({
      series: [
        {
          data: flatData,
          dimensions: ["x", "y"],
          symbol: showSymbol ? "circle" : "none",
        },
      ],
    });

    loading.value = false;
    // 数据加载完成后立即 resize 一次，确保初始尺寸正确
    myChart?.resize();
  };

  worker.postMessage({
    action: props.dataUrl ? "processData" : "generateData",
    url: props.dataUrl,
    dataSize: props.dataSize,
    samplePoints: props.samplePoints,
  });

  // datazoom 节流处理
  myChart.on("datazoom", (params: any) => {
    let start: number, end: number;

    if (params.batch) {
      start = params.batch[0].start;
      end = params.batch[0].end;
    } else {
      start = params.start;
      end = params.end;
    }

    // 新增：判断是否接近“全范围”
    const isFullView = start <= 0.1 && end >= 99.9; // 容忍一点小误差

    if (isFullView) {
      // 回到全览 → 直接要预览数据（1000点）
      worker?.postMessage({
        action: "resetToPreview",
        samplePoints: 1000,
      });
      return;
    }

    // 正常局部缩放 → 走原来的 resample
    if (throttleTimer) return;

    throttleTimer = window.setTimeout(() => {
      worker?.postMessage({
        action: "resample",
        startRatio: start / 100,
        endRatio: end / 100,
        samplePoints: props.samplePoints,
      });
      throttleTimer = null;
    }, 30);
  });

  resizeObserver = new ResizeObserver(() => {
    myChart?.resize();
  });
  resizeObserver.observe(chartRef.value);
  setTimeout(() => myChart?.resize(), 100);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  if (throttleTimer) clearTimeout(throttleTimer);
  myChart?.dispose();
  worker?.terminate();
});
</script>

<style scoped>
.chart-wrapper {
  position: relative;
  width: 100%;
  height: 100%; /* 关键：占满父容器高度 */
}

.chart-container {
  width: 100%;
  height: 100%; /* 确保容器撑满 */
  min-height: 300px; /* 防止高度塌陷，可根据需求调整或删除 */
  background: #f9f9f9;
}

.loading-overlay {
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.8);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 10;
  font-weight: bold;
  color: #5470c6;
}
</style>
