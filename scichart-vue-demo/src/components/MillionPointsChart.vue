<template>
  <div class="chart-wrapper">
    <div ref="sciChartRoot" class="sci-chart-container"></div>

    <div class="info-bar">
      <span class="label">数据量:</span>
      <span class="value">{{ pointCount.toLocaleString() }}</span>
      <span class="divider">|</span>
      <span class="label">渲染耗时:</span>
      <span class="value">{{ renderTime }}ms</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import {
  SciChartSurface,
  NumericAxis,
  FastLineRenderableSeries,
  XyDataSeries,
  SciChartJsNavyTheme,
  MouseWheelZoomModifier,
  ZoomPanModifier,
  ZoomExtentsModifier,
  RolloverModifier,
  EAxisAlignment,
  EAutoRange,
  NumberRange,
} from "scichart";

const sciChartRoot = ref<HTMLDivElement | null>(null);
const pointCount = ref(1000000);
const renderTime = ref(0);

let sciChartSurface: SciChartSurface | null = null;

onMounted(async () => {
  if (!sciChartRoot.value) return;

  const start = performance.now();

  try {
    // 1. 配置加载（通常建议在全局 main.ts 配置一次）
    await SciChartSurface.configure({
      wasmUrl: "/js/scichart2d.wasm",
    });

    // 2. 初始化图表，使用深蓝主题
    const { wasmContext, sciChartSurface: surface } =
      await SciChartSurface.create(sciChartRoot.value, {
        theme: new SciChartJsNavyTheme(),
        disableMetricReporting: true, // 干净的界面，不显示水印（如果是授权版）
      });
    sciChartSurface = surface;

    // 3. 配置坐标轴
    const xAxis = new NumericAxis(wasmContext, {
      axisTitle: "时间序列",
      labelStyle: { color: "#64748b" },
    });
    sciChartSurface.xAxes.add(xAxis);

    const yAxis = new NumericAxis(wasmContext, {
      axisAlignment: EAxisAlignment.Left,
      growBy: new NumberRange(0.1, 0.1), // 给上下留出 10% 的呼吸空间，视觉更美观
      autoRange: EAutoRange.Always,
      drawMinorGridLines: false,
      labelStyle: { color: "#64748b" },
    });
    sciChartSurface.yAxes.add(yAxis);

    // 4. 生成模拟数据
    const dataSeries = new XyDataSeries(wasmContext, {
      fifoCapacity: pointCount.value,
    });

    const xValues = new Float64Array(pointCount.value);
    const yValues = new Float64Array(pointCount.value);
    for (let i = 0; i < pointCount.value; i++) {
      xValues[i] = i;
      yValues[i] =
        Math.sin(i * 0.0001) * 20 +
        Math.cos(i * 0.00005) * 40 +
        (Math.random() - 0.5) * 10;
    }
    dataSeries.appendRange(xValues, yValues);

    // 5. 创建渲染序列 - 使用深蓝色调 (#3b82f6)
    const lineSeries = new FastLineRenderableSeries(wasmContext, {
      dataSeries,
      stroke: "#3b82f6", // 科技蓝
      strokeThickness: 2,
      antiAliasing: true,
    });
    sciChartSurface.renderableSeries.add(lineSeries);

    // 6. 添加交互
    sciChartSurface.chartModifiers.add(
      new MouseWheelZoomModifier(),
      new ZoomPanModifier({ enableXDragging: true, enableYDragging: false }),
      new ZoomExtentsModifier(),
      new RolloverModifier({
        showTooltip: true,
        tooltipDataTemplate: (seriesInfo) => {
          return [
            `X: ${seriesInfo.xValue}`,
            `Y: ${seriesInfo.yValue.toFixed(2)}`,
          ];
        },
      })
    );

    const end = performance.now();
    renderTime.value = Math.round(end - start);
  } catch (err) {
    console.error("SciChart 初始化失败:", err);
  }
});

onUnmounted(() => {
  sciChartSurface?.delete();
});
</script>

<style scoped>
/* 容器：锁定屏幕宽高，使用 Flex 布局 */
.chart-wrapper {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden; /* 严禁滚动条 */
  background: #0b1120; /* 极深蓝色背景 */
  margin: 0;
  padding: 0;
  position: fixed;
  top: 0;
  left: 0;
}

/* 图表区：占据所有可用空间 */
.sci-chart-container {
  flex: 1;
  width: 100%;
  min-height: 0; /* 关键：允许 flex 项目收缩，防止溢出 */
}

/* 信息栏：精致的深色半透明风格 */
.info-bar {
  height: 40px;
  background: #1e293b;
  border-top: 1px solid #334155;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
  font-size: 13px;
}

.label {
  color: #94a3b8;
}

.value {
  color: #3b82f6;
  font-weight: bold;
}

.divider {
  color: #334155;
}
</style>
