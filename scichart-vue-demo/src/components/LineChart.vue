<template>
  <div class="analysis-container">
    <div class="section main-section">
      <div class="card-header">
        <span class="title">📈 全局数据预览</span>
        <span class="badge">{{ props.dataSize.toLocaleString() }} 点</span>
      </div>
      <div class="chart-box">
        <div v-if="loading" class="loading-overlay">
          <div class="spinner"></div>
          <span>大数据加载中...</span>
        </div>
        <div ref="chartRef" class="chart-content"></div>
      </div>
    </div>

    <div class="toolbar">
      <div class="instrution" v-if="isSelecting">
        <span class="blink">●</span> 请在上方图表中点击选择【起点】和【终点】
      </div>
      <div class="instrution" v-else-if="selectionRange">
        已选范围: {{ formatTime(selectionRange.start) }} 至
        {{ formatTime(selectionRange.end) }}
      </div>
      <div class="instrution" v-else>使用“截取”功能查看局部细节</div>

      <div class="button-group">
        <button
          @click="enterSelectMode"
          :class="['btn', 'btn-select', { 'is-active': isSelecting }]"
        >
          {{ isSelecting ? "取消选择" : "✂️ 截取" }}
        </button>
        <button
          @click="confirmSelection"
          class="btn btn-confirm"
          :disabled="!selectionRange"
        >
          确定
        </button>
        <button
          @click="resetSelection"
          class="btn btn-reset"
          v-if="selectionRange"
        >
          重置
        </button>
      </div>
    </div>

    <div class="section sub-section">
      <div class="card-header">
        <span class="title">🔍 截取详情</span>
        <span class="tag" v-if="hasSubData">已缩放</span>
      </div>
      <div class="chart-box">
        <div v-if="!hasSubData" class="empty-state">
          <p>暂无截取数据，请在上方选择范围</p>
        </div>
        <div ref="subChartRef" class="chart-content"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, shallowRef, onUnmounted } from "vue";
import * as echarts from "echarts";

const props = withDefaults(
  defineProps<{
    dataSize?: number;
    samplePoints?: number;
  }>(),
  {
    dataSize: 5_000_000,
    samplePoints: 2000,
  },
);

const chartRef = ref<HTMLDivElement | null>(null);
const subChartRef = ref<HTMLDivElement | null>(null);
const loading = ref(true);
const isSelecting = ref(false);
const hasSubData = ref(false);

let myChart: echarts.ECharts | null = null;
let subChart: echarts.ECharts | null = null;
let worker: Worker | null = null;
let throttleTimer: number | null = null;
let resizeTimer: number | null = null;

let resizeObserver: ResizeObserver | null = null;

// 截取状态记录
const selectionRange = ref<{ start: number; end: number } | null>(null);
let clickCount = 0;
let tempStart = 0;

// 子图专用的节流 timer
let subThrottleTimer: number | null = null;

// --- 初始化子图表 ---
const initSubChart = () => {
  if (!subChartRef.value) return;
  subChart = echarts.init(subChartRef.value);
  subChart.setOption({
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
      // 必须手动处理 TypedArray 的数据格式化
      formatter: (params: any) => {
        const p = params[0];
        if (!p.value) return "";
        // 这里的 p.value[0] 是从 dimensions ["x", "y"] 中解析出的时间戳
        const date = new Date(p.value[0]);
        const timeStr = date.toLocaleTimeString("zh-CN", { hour12: false });
        return `时间: ${timeStr}<br/>数值: <b>${p.value[1].toFixed(4)}</b>`;
      },
    },
    xAxis: {
      type: "time",
      minInterval: 1000, // 限制刻度
      axisLabel: { formatter: "{HH}:{mm}:{ss}" },
    },
    yAxis: { type: "value" },
    dataZoom: [
      {
        type: "inside",
        minValueSpan: 30 * 1000, // 强制最少显示 30 秒的数据量
        minValueSpan: 1000,
        moveOnMouseMove: true,
      },
      {
        type: "slider",
        filterMode: "none",
        realtime: false,
        minValueSpan: 30 * 1000, // 强制最少显示 30 秒的数据量
        minValueSpan: 1000,
      },
    ], // 子图也支持缩放以配合高精度数据
    series: [
      {
        type: "line",
        symbol: "none",
        dimensions: ["x", "y"], // 必须与主图一致以解析 TypedArray
        encode: { x: 0, y: 1 },
      },
    ],
  });
  // 新增：监听 datazoom 事件，实现动态 resampling
  subChart.on("datazoom", (params: any) => {
    if (!selectionRange.value) return; // 无截取范围时忽略

    let startPercent: number, endPercent: number;
    if (params.batch) {
      startPercent = params.batch[0].start;
      endPercent = params.batch[0].end;
    } else {
      startPercent = params.start;
      endPercent = params.end;
    }

    // 计算当前可见时间范围（基于原 selectionRange）
    const origStart = selectionRange.value.start;
    const origEnd = selectionRange.value.end;
    const visibleStart =
      origStart + (origEnd - origStart) * (startPercent / 100);
    const visibleEnd = origStart + (origEnd - origStart) * (endPercent / 100);

    // 判断是否接近全范围（类似主图）
    const isFullView = startPercent <= 0.1 && endPercent >= 99.9;
    if (isFullView) {
      // 回到全截取范围 → 请求原截取数据
      worker?.postMessage({
        action: "resampleByTime",
        startTime: origStart,
        endTime: origEnd,
        samplePoints: props.samplePoints, // 用初始采样点
      });
      return;
    }

    // 正常 zoom → 节流请求新数据
    if (subThrottleTimer) return;
    subThrottleTimer = window.setTimeout(() => {
      worker?.postMessage({
        action: "resampleByTime",
        startTime: visibleStart,
        endTime: visibleEnd,
        samplePoints: 5000, // 子图 zoom 时用更高采样点，提高密度
      });
      subThrottleTimer = null;
    }, 30);
  });
};

// --- 截取逻辑 ---
const enterSelectMode = () => {
  if (isSelecting.value) {
    // 如果已经是选择模式，再次点击则退出
    isSelecting.value = false;
    myChart?.getZr().setCursorStyle("default");
    return;
  }
  isSelecting.value = true;
  clickCount = 0;
  // 更新主图鼠标样式
  if (myChart) myChart.getZr().setCursorStyle("crosshair");
};

const handleChartClick = (params: any) => {
  if (!isSelecting.value) return;

  // 使用 convertFromPixel 将像素坐标转换为数值（时间戳）
  // params 结构在 getZr 监听下不同，我们直接从 chart 实例转换
  const pointInPixel = [params.offsetX, params.offsetY];
  if (myChart?.containPixel("grid", pointInPixel)) {
    const pointInGrid = myChart.convertFromPixel(
      { seriesIndex: 0 },
      pointInPixel,
    );
    const timestamp = pointInGrid[0]; // 获取转换后的 X 轴时间戳值

    clickCount++;
    if (clickCount === 1) {
      tempStart = timestamp;
      // 可选：第一次点击也给个视觉反馈，画一条线或一个点
    } else if (clickCount === 2) {
      const start = Math.min(tempStart, timestamp);
      const end = Math.max(tempStart, timestamp);
      selectionRange.value = { start, end };
      updateMainChartMask(start, end);
      isSelecting.value = false;
      myChart?.getZr().setCursorStyle("default");
    }
  }
};

const updateMainChartMask = (start: number, end: number) => {
  myChart?.setOption({
    series: [
      {
        // 必须指定是哪条线，否则 setOption 可能会增加一条新线而不是更新
        type: "line",
        markArea: {
          silent: true, // 设为 true，防止遮罩拦截点击事件
          itemStyle: {
            color: "rgba(24, 144, 255, 0.2)",
            borderWidth: 1,
            borderColor: "rgba(24, 144, 255, 0.5)",
          },
          data: [[{ xAxis: start }, { xAxis: end }]],
        },
      },
    ],
  });
};

const confirmSelection = () => {
  if (!selectionRange.value || !worker) return;

  // 子图进入加载状态
  subChart?.showLoading({ text: "正在提取片段...", color: "#1890ff" });
  hasSubData.value = true;

  // 初始请求用较低采样点（概览）
  worker.postMessage({
    action: "resampleByTime",
    startTime: selectionRange.value.start,
    endTime: selectionRange.value.end,
    samplePoints: 2000,
  });
};

const resetSelection = () => {
  selectionRange.value = null;
  myChart?.setOption({ series: [{ markArea: { data: [] } }] });
};

// 节流 resize（避免过于频繁调用）
const resizeChart = () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (myChart && chartRef.value) {
      myChart.resize();
    }
  }, 100); // 100ms 节流
};

// 格式化时间辅助函数
const formatTime = (ts: number) => {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
};

onMounted(() => {
  if (!chartRef.value) return;

  // 初始化图表
  myChart = echarts.init(chartRef.value, null, {
    renderer: "canvas",
  });

  // 基础配置
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
      confine: true, // 防止提示框超出容器
      formatter: (params: any) => {
        const p = params[0];
        const d = new Date(p.value[0]);
        const timeStr = d.toTimeString().split(" ")[0]; // 获取 HH:mm:ss
        // 如果缩放到 1:1，这里会显示精确的每一秒
        return `时间：${timeStr}<br/>数值：${p.value[1].toFixed(2)}`;
      },
    },
    xAxis: {
      type: "time",
      boundaryGap: false,
      minInterval: 1000, // 关键：限制最小刻度为 1秒 (1000ms)
      axisLabel: {
        formatter: (value: number) => {
          const date = new Date(value);
          return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
        },
      },
    },
    yAxis: {
      type: "value",
      min: 0,
      silent: true,
    },
    dataZoom: [
      {
        type: "inside",
        minValueSpan: 30 * 1000, // 强制最少显示 30 秒的数据量
        minValueSpan: 1000,
        moveOnMouseMove: true,
      },
      {
        type: "slider",
        filterMode: "none",
        realtime: false,
        minValueSpan: 30 * 1000, // 强制最少显示 30 秒的数据量
        minValueSpan: 1000,
      },
    ],
    series: [
      {
        type: "line",
        data: [],
        symbol: "none",
        encode: {
          x: 0, // 对应 flatData 中的偶数索引位
          y: 1, // 对应 flatData 中的奇数索引位
        },
        sampling: "lttb",
        large: true,
        largeThreshold: props.samplePoints,
        progressive: 2000,
        lineStyle: { width: 1, join: "bevel" },
        animation: false,
        universalTransition: false,
      },
    ],
  });

  // 使用 zr 监听可以确保即使点在空白处也能触发坐标转换
  myChart?.getZr().on("click", handleChartClick);

  // 创建 Worker
  worker = new Worker(new URL("../works/dataWorker.ts", import.meta.url), {
    type: "module",
  });

  initSubChart();

  worker.onmessage = (event) => {
    const { xArray, yArray, count, isSubChart, error } = event.data;
    if (error) return;

    const flatData = new Float64Array(count * 2);
    for (let i = 0; i < count; i++) {
      flatData[i * 2] = xArray[i];
      flatData[i * 2 + 1] = yArray[i];
    }

    const seriesUpdate = {
      data: flatData,
      dimensions: ["x", "y"],
      encode: { x: 0, y: 1 },
      sampling: count > 50000 ? "lttb" : undefined,
      large: true,
      largeThreshold: 2000,
    };

    if (isSubChart) {
      hasSubData.value = true;

      // 关键：先移除监听，避免 setOption 触发 datazoom 回弹
      subChart?.off("datazoom");

      subChart?.setOption(
        {
          xAxis: { type: "time", minInterval: 1000 },
          yAxis: { type: "value", scale: true },
          series: [
            {
              ...seriesUpdate,
              type: "line",
              symbol: count < 10 ? "circle" : "none",
            },
          ],
        },
        {
          replaceMerge: ["series"],
          lazyUpdate: true, // 尝试减少重绘冲突
        },
      );

      // 更新完再恢复监听
      subChart?.on("datazoom" /* 你的 datazoom 回调函数 */);

      // 重置 zoom 只在初始或必要时做，不要每次都 dispatch
      // 如果你想保持当前 zoom，不要 dispatchAction dataZoom reset
      // subChart?.dispatchAction({ type: "dataZoom", start: 0, end: 100 });  ← 注释掉或条件执行

      subChart?.hideLoading();
    } else {
      // 主图更新
      myChart?.setOption({ series: [seriesUpdate] });
      loading.value = false;
    }
  };

  worker.postMessage({
    // action: "generateData"
    // action: "processData"
    action: "generateData",
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
      // 回到全览 → 直接要预览的数据
      worker?.postMessage({
        action: "resetToPreview",
        samplePoints: props.samplePoints,
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
    subChart?.resize();
  });
  resizeObserver.observe(chartRef.value);
  setTimeout(() => {
    myChart?.resize();
    subChart?.resize();
  }, 100);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  if (throttleTimer) clearTimeout(throttleTimer);
  if (subThrottleTimer) clearTimeout(subThrottleTimer); // 新增
  myChart?.dispose();
  worker?.terminate();
});
</script>

<style scoped>
.analysis-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 12px;
  background-color: #f5f7fa;
  gap: 12px;
  box-sizing: border-box;
}

.section {
  background: #fff;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
  overflow: hidden;
}

/* 比例分配：主图 55%, 子图 35%，剩余给工具栏 */
.main-section {
  flex: 55;
}
.sub-section {
  flex: 35;
  border-top: 2px solid #1890ff;
}

.card-header {
  padding: 8px 16px;
  background: #fafafa;
  border-bottom: 1px solid #f0f0f0;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.title {
  font-weight: bold;
  color: #333;
  font-size: 14px;
}
.badge {
  font-size: 11px;
  background: #eee;
  padding: 2px 6px;
  border-radius: 4px;
  color: #666;
}
.tag {
  font-size: 11px;
  background: #e6f7ff;
  color: #1890ff;
  padding: 2px 6px;
  border-radius: 4px;
}

.chart-box {
  flex: 1;
  position: relative;
  min-height: 0; /* 修复 flex 子元素高度塌陷 */
}

.chart-content {
  width: 100%;
  height: 100%;
}

/* 工具栏样式 */
.toolbar {
  height: 50px;
  background: #fff;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
}

.instrution {
  font-size: 13px;
  color: #666;
}
.blink {
  color: #ff4d4f;
  margin-right: 4px;
  animation: blinker 1s linear infinite;
}

.button-group {
  display: flex;
  gap: 10px;
}

.btn {
  padding: 6px 20px;
  border-radius: 4px;
  border: 1px solid #d9d9d9;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}

.btn-select.is-active {
  background: #ff4d4f;
  color: white;
  border-color: #ff4d4f;
}

.btn-confirm {
  background: #1890ff;
  color: white;
  border-color: #1890ff;
}
.btn-confirm:disabled {
  background: #f5f5f5;
  color: #ccc;
  border-color: #d9d9d9;
  cursor: not-allowed;
}

.btn-reset {
  color: #666;
}

/* 动画与状态 */
.loading-overlay,
.empty-state {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.8);
}

.empty-state {
  color: #999;
  font-size: 14px;
}

.spinner {
  width: 30px;
  height: 30px;
  border: 3px solid #f3f3f3;
  border-top: 3px solid #1890ff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 10px;
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
@keyframes blinker {
  50% {
    opacity: 0;
  }
}
</style>
