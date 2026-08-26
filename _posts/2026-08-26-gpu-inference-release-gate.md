---
title: "让 TensorRT 先过安检：我给 GPU 推理做了一道发布门禁"
date: 2026-08-26 10:30:00 +0800
layout: post
description: "从一个能跑的 Tiny Transformer，到一套会拦截错误发布的 GPU 推理质量门禁。"
category: "GPU 工程"
tags: [GPU, CUDA, PyTorch, TensorRT, Triton, 测试]
featured: true
cover_style: "gpu"
---

在做 GPU 推理时，最常听到的一句话是：“模型能跑了。”这句话当然没错，就像车能发动也没错。但如果下一句就是“那就上线吧”，我通常会先踩一下刹车：精度真的对吗？换个 batch 会不会炸？显存会不会越界？延迟到底是模型算出来的，还是 CUDA 启动开销占掉的？

于是我做了一个小而完整的实验室：`ai-gpu-test-lab`。它不追求把模型做大，而是把“GPU 推理是否值得发布”拆开、测清楚、留下证据。

## 到底想解决什么

我觉得 GPU 推理最麻烦的地方，不是让程序第一次跑起来，而是让它在变化之后仍然可信：换一个 batch、换一种 dtype、换一台卡、换一个 TensorRT 版本，结果还能不能解释？

我把问题拆成四件事：

1. **结果是否正确**：和高精度参考实现比较，区分正常浮点误差与真正的逻辑错误；
2. **边界是否安全**：动态 shape、非连续 Tensor、非对齐维度、错误输入都要有明确行为；
3. **性能是否稳定**：不仅看平均延迟，还看 p95、波动和长时间运行后的退化；
4. **发布是否可追溯**：记录环境指纹、模型和 engine 的 hash，让一次测试可以被复现。

所以我把它做成了一条“推理装配线”：模型是原料，PyTorch/Triton/TensorRT 是不同加工设备，测试是质检工位，baseline 是已经签字的样品，release gate 是最后的放行闸门。

## 从输入到报告，代码怎么串起来

跑一轮完整测试，大致会经过这条链路：

```text
生成输入
   ↓
PyTorch reference ──┐
                    ├─ 数值比较、NaN/Inf 检查、梯度检查
CUDA/Triton/TRT ───┘
   ↓
动态 shape 与契约检查
   ↓
预热、计时、p95/median 统计
   ↓
baseline 对比 + release decision
   ↓
summary.json / junit.xml / release-summary.md
```

我把代码分成几层：`src/contract.py` 集中定义模型维度、输入输出名称和 profile；`src/model.py` 提供可导出、可复现的 PyTorch 模型；`export_onnx.py` 和 `build_engine.py` 负责把模型变成 TensorRT engine；`trt_runner.py` 只处理输入校验、动态 shape、CUDA stream 和执行；`tests/` 则把正确性、边界、性能和稳定性拆成独立的 pytest 用例。这样分层是有意的：模型错了、engine 错了，还是 Runner 错了，我都应该能从报告里看出是哪一环先出问题。

## 为什么要做 reference 和 candidate

把 reference 当成稳定的比较基准，把 candidate 当成真实部署路径。candidate 可能走不同 kernel、不同累加精度或融合策略，所以我不会简单要求每个 bit 完全一致，而是结合 dtype 和算子设置 `atol`、`rtol`，同时检查误差分布、最大误差位置和异常值。这样既不会把合理的并行归约差异报成故障，也不会用一个过宽阈值掩盖整片输出错位。

## 一轮测试具体怎么做

先用固定随机种子生成输入，保证不同后端拿到同一批数据；再做 warmup，避免第一次 CUDA 初始化污染延迟；之后同步 CUDA stream，采集多轮样本并计算统计量。正确性测试和性能测试我会分开跑：前者关注数值和契约，后者关注时间和稳定性。

性能 baseline 不只是一个数字，而是“硬件 + 软件 + 代码版本”的组合。我在报告里保存了 RTX 4090 D、驱动 595.71.05、CUDA 12.4、TensorRT 10.16.1.11、Torch 2.6.0+cu124 和 git commit。环境指纹不一致时，我把结果标记为 `NOT_COMPARABLE`，避免把换卡造成的差异误判成代码回归。

## 这套测试对我有什么用

它把我原本一次性的 GPU 实验变成了可重复的工程流程。出了问题时，我能更快知道“哪里错了”；过几周回头看，我也能根据报告还原当时的环境和输入。

更重要的是，我把性能和正确性放在同一张地图上：一个 kernel 可能快了 10%，但如果 FP16 溢出、动态 shape 崩溃，或者 p95 抖得像心电图，我就不能把它当成完成了。一个真正能用的推理系统，必须同时回答“算得对不对”和“跑得稳不稳”。

## 先造一辆足够小的测试车

在这个项目里用的是 Tiny Transformer Encoder：Embedding、Linear、GELU、LayerNorm、Linear、Softmax，再接一层 LayerNorm。我故意没有追求参数量，因为我要测的不是模型有多大，而是模型经过不同执行路径之后，行为有没有变。

我给每个算子准备了两份实现：**reference** 是 CPU 上的 PyTorch 计算，负责当裁判；**candidate** 是 CUDA、Triton 或 TensorRT 的实际路径，负责接受检查。两边都调用 PyTorch，只能说明 PyTorch 后端本身没问题；只有把 candidate 换成 Triton kernel 或 TensorRT engine，比较才真正有意义。

## 测试不是一锅粥

### 算子正确性

让 MatMul、GELU、Softmax、LayerNorm 跑 contiguous、transposed、不同 dtype 和不同 shape，检查绝对误差、相对误差、NaN/Inf，以及梯度是否合理。Shape 不能只写一个 `1024x1024`：`[1,4096,4096]` 用来模拟 decoding，`[1024,4096,4096]` 用来模拟 prefill，`[3,4095,4097]` 专门抓 tail 越界和错误 padding。

### TensorRT 契约

我把 ONNX 导出、engine 构建、动态 shape、输入 dtype、输入名称都当成部署契约。测试会验证 profile 的 min/opt/max 边界，也会确认超出 profile、缺少 tensor name 这样的坏输入会被拒绝。

### 性能与稳定性

我会记录 median、p95、mean 和标准差。baseline 固定 GPU、驱动、CUDA、TensorRT、Torch 和 git commit。当前 RTX 4090 D 环境的 1x8、4x128、8x512 median 约为 0.09 ms，候选结果在批准基线内，所以发布结论是 `PASS`。小模型的数字有个陷阱：时间很可能主要花在 kernel launch 和框架调度上，所以我只拿它验证门禁和回归，不拿它宣称“大模型吞吐天下第一”。

### 证据链

我让每轮运行产出 `summary.json`、`junit.xml` 和 `release-summary.md`，并记录 model/engine hash。结果不再只是“我本地跑过”，而是一组别人可以按命令复现的文件。

```bash
PYTHONPATH=. python scripts/run_suite.py \
  --suite operator,triton,correctness,dynamic,negative,performance,soak \
  --baseline baselines/rtx4090d-trt10.json
```

我把发布门禁定成三个状态：`PASS`（全部通过）、`BLOCKED`（明确失败，不能发布）、`NOT_COMPARABLE`（环境指纹变化，先重建 baseline）。它不会因为“这次刚好跑通”就放行，也不会因为换了 GPU，就假装两次数据还能直接比较。

## 今天遇到的几个坑

### FP32 MatMul：不是每个小数都必须一模一样

**现象**：`matmul-1024x1024-float32-transposed` 失败，最大绝对误差 `8.25e-05`，阈值却是 `1e-06`。

**最后查到的原因**：CPU BLAS 和 GPU cuBLAS 的并行归约顺序不同，浮点加法又不满足结合律。检查 `get_float32_matmul_precision=highest`、`allow_tf32=False` 后，我排除了 TF32 干扰。

**我是怎么处理的**：我先打印 dtype、设备和 TF32 开关，再定位最大误差的索引，看误差到底集中在哪里。最后按算子和 dtype 设置有依据的 `atol/rtol`，同时保留严格模式，用来抓数量级错误。

### FP16 MatMul：数值没错，范围先投降了

**现象**：边界输入产生大量 `inf/-inf`。

**最后查到的原因**：FP16 最大有限值约为 65504，输入 `1e4` 做矩阵乘法后很容易溢出。

**我是怎么处理的**：我把“有限域精度测试”和“预期溢出测试”分开。前者使用合理的输入范围，后者明确检查 Inf 是否按预期出现。

### Transposed shape：布局转了，数学维度也被顺手转了

**现象**：`(1023x3) @ (1023x1023)` 报维度不匹配。

**最后查到的原因**：我直接对二维输入调用 `.T`，把逻辑 shape 从 `[3,1023]` 变成了 `[1023,3]`。我原本想测的是非连续内存，结果把题目本身改了。

**我是怎么处理的**：我先按反向 shape 生成数据，再 transpose 回目标逻辑 shape，并补了一条 transposed 回归用例。

### GELU 和 LayerNorm：只差几个 ulp，也值得解释

**现象**：GELU 仅 2 个元素超阈值（最大 `1.04e-06`）；LayerNorm FP16 transposed 最大误差 `0.00201`，阈值 `0.001`。

**最后查到的原因**：近似函数、归约顺序、FP16 累加精度和非连续访问路径都会带来这种差异。

**我是怎么处理的**：我分别建立 FP32/FP16、连续/非连续的容差表，并把超阈值样本的索引和分位数写进报告。

### TensorRT 正确性：96% 不一致，最后发现是输出 dtype 契约

**现象**：96% 元素不接近，最大绝对误差约 512；打印 engine IO 后发现输出是 `DataType.FLOAT`，Runner 却按 FP16 分配和比较。

**是怎么查的**：我先打印 engine 的输入输出名称、dtype、shape，再打印 runtime shape `(1,8,256)`，确认动态维度没有错。

**我最后查到的原因**：`BuilderFlag.FP16` 只允许内部使用 FP16，并不保证输出 tensor 自动变成 FP16。

**我是怎么处理的**：我让模型输出显式执行 `to(torch.float16)`，重新导出 ONNX、重新构建 plan；Runner 则查询实际 engine dtype，并保留输出契约断言。

## 收尾：让测试替你记住细节

我最后想留下的不是一张漂亮的速度截图，而是一条可以追溯的链：我当时用了什么输入、engine 是哪一版、误差出在哪里、性能有没有回退、为什么允许或拒绝发布。

GPU 很快，但它不会替我解释结果。让测试替我记住细节，把解释写进测试，把证据写进报告。下一次再遇到 `inf`、`512`，或者小数点后那点说不清的误差时，我至少不用再靠猜。
