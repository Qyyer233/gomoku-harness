# Rapfi 引擎（第三方组件）

这个目录里的引擎程序来自 **Rapfi**，作者 Haobin Duan（dhbloo）及贡献者（见 `AUTHORS`）。
本项目没有修改引擎程序本身，只是把它当作独立进程调用（Gomocup 协议，经标准输入输出通信）。

| 项目 | 内容 |
| --- | --- |
| 上游仓库 | https://github.com/dhbloo/rapfi |
| 使用版本 | Rapfi 2025-06-15（发布标签 `250615`） |
| 对应源码 | https://github.com/dhbloo/rapfi/releases/tag/250615 |
| 引擎许可证 | GNU GPL v3.0（全文见本目录 `COPYING`） |
| 权重文件来源 | https://github.com/dhbloo/rapfi-networks（CC0 1.0，公有领域） |

## 文件

| 文件 | 说明 |
| --- | --- |
| `pbrain-rapfi-windows-avxvnni.exe` / `-avx2.exe` / `-sse.exe` | 官方发布的 Windows 可执行文件，未经修改。启动时按 CPU 指令集自动挑最快的那个 |
| `mix9svq*.bin.lz4`、`model210901.bin` | 官方权重，未经修改 |
| `config.toml` | 官方配置，**本项目修改过**：权重列表里加入了下面那个 12 路补丁权重（排在官方权重之后） |
| `config-noeval.toml` / `config-nonnue12.toml` | 本项目为对照实验添加的配置 |
| **`mix9svqfreestyle_bsmix_bs12.bin.lz4`** | **本项目修改过的权重**，见下 |

## 12 路补丁权重（修改说明）

官方自由规则权重 `mix9svqfreestyle_bsmix.bin.lz4` 的文件头声明适用 13~22 路，
在 12 路上不会加载（引擎改用传统估值）。`mix9svqfreestyle_bsmix_bs12.bin.lz4` 由它生成：

- **只改了文件头里 `boardsize_mask` 的 1 个字节**（点亮 12 路那一位），网络参数一字未动；
- 相应重算了 LZ4 帧末尾的内容校验和。

生成命令（可自行复现）：

```bash
node tools/rapfi-weight.js patch \
  engines/rapfi/mix9svqfreestyle_bsmix.bin.lz4 \
  engines/rapfi/mix9svqfreestyle_bsmix_bs12.bin.lz4 --add-size 12
```

这是本项目自己的改动，不是 Rapfi 官方行为，也不代表 Rapfi 作者的背书。
实测 12 路上开启 NNUE 比不开强约 35 Elo（609 局），与官方支持的 13 路上的增益一致。
