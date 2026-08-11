# 代码、数据与第三方许可边界

> 本文用于记录工程边界，不构成法律意见。数据条款可能变化；每次正式下载、发布或再分发前，都应重新检查数据集页面、元数据和适用条款。

## 1. 项目原创代码与文档

仓库当前**没有授予开源许可**。项目原创代码、文档和界面适用根目录 [`LICENSE`](../LICENSE) 中的
“All rights reserved”通知。公开可读、可 clone 或 GitHub 可 fork 不等于获得复制、修改或再分发授权。
若维护者未来决定采用开源许可证，应通过单独提交替换 `LICENSE`，同步更新包元数据，并明确生效版本；
在此之前不要把本项目标注为 MIT、Apache-2.0 或其它开放许可证。

`LICENSE` 只覆盖项目权利人有权许可的原创材料，不会把第三方数据或依赖重新许可。

## 2. OECD ICIO 原始数据

本项目通过 `pymrio.download_oecd` 下载 OECD Inter-Country Input-Output (ICIO) 数据。当前正式产物使用
2023 release 中的 2016–2020 表；原始 CSV、下载日志和计算后的 `data/processed/` 均被 Git 忽略，
不随源代码仓库分发。

使用或再分发前必须查看：

- 数据集页面：<https://www.oecd.org/en/data/datasets/inter-country-input-output-tables.html>
- OECD Terms & Conditions：<https://www.oecd.org/en/about/terms-conditions.html>
- 2023 方法文档：<https://doi.org/10.1787/5a5d0665-en>

OECD 通用条款允许的数据复用范围仍可能被数据集专门条款、元数据或第三方权利限制。操作者有责任在下载时
检查数据页面和 metadata/source 信息。不得把本仓库的代码许可解释为 OECD 数据许可，也不得使用 OECD
标识或文案暗示 OECD 审核、参与或背书。

建议在课程材料、导出报告和公开衍生结果中保留以下引用，并补充实际访问日期：

```text
OECD (2023), Inter-Country Input-Output Tables (ICIO), 2023 release,
https://www.oecd.org/en/data/datasets/inter-country-input-output-tables.html
(accessed YYYY-MM-DD).
```

方法引用：

```text
Yamano et al. (2023), Development of the OECD Inter-Country Input-Output
Database 2023, OECD Science, Technology and Industry Working Papers 2023/08,
https://doi.org/10.1787/5a5d0665-en.
```

服务端生成的第 16 步报告会自动写入上述数据集、方法和条款链接。`dataset.json` 只记录计算时间、年份和
数据来源说明；它不是许可证明，也不能替代下载时的条款记录。

## 3. 衍生产物的再分发

`data/processed/` 包含由 ICIO 计算的国家、行业和网络指标。即使它们经过转换或聚合，也不应
自动视为不受源数据条款约束。向仓库外复制完整 artifact、面板 CSV、批量表格或可逆明细前，应完成：

1. 确认下载时适用的 OECD 条款、数据集 metadata/source 和第三方权利；
2. 判断目标用途、接收方和再分发方式是否被允许；
3. 保留 OECD 引用、版本、访问日期和本项目算法说明；
4. 不包含数据库凭证、学生记录或认证密钥；
5. 对外发布前由课程负责人或机构的数据/法务负责人复核。


## 4. 教学 mock 与 CI 合成数据

以下内容不应被冒充为官方数据：

- 政策冲击、HS→ICIO crosswalk、宏观控制和 GDP 平减指数教学 mock；
- `scripts/build_ci_synthetic_data.py` 生成的 CI-only OECD-shaped 表；
- 由这些 mock 得出的回归、安慰剂和报告结论。

CI 合成表由项目代码确定性生成，不复制 OECD 数值，只用于测试 schema、流水线和浏览器流程。其存在不改变
项目原创代码当前“未授予开放许可”的状态。教学 mock 中若未来接入第三方事件、映射或宏观数据，必须在本
文件增加来源、版本、条款和引用后才能发布。

## 5. 第三方软件

Python、JavaScript、浏览器和系统依赖分别适用各自许可证。`uv.lock` 与 `frontend/bun.lock` 固定版本，
但不替代第三方 notice。制作可分发镜像或安装包时，应从锁文件生成依赖清单/SBOM，收集许可证文本，并在
发布前处理 copyleft、字体、浏览器二进制及系统包的单独义务。
