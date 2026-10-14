---
learnflow_id: "learnflow-247b9f568555b1ab86e7d55f1cf785de"
chapter_id: "chapter-247b9f568555b1ab86e7d55f1cf785de"
source_url: "https://fastapi.tiangolo.com/zh/tutorial/body/"
title: "请求体¶"
created_at: "2026-10-12T00:00:00+00:00"
updated_at: "2026-10-12T00:00:00+00:00"
schema_version: 1
---

# 请求体¶

## 来源

- URL: "https://fastapi.tiangolo.com/zh/tutorial/body/"

## LearnFlow 受控摘录

<!-- LEARNFLOW_CONTROLLED_BEGIN -->
<!-- LF_BLOCK id=title fingerprint=075235d62fae52f3993b7649 -->
# 请求体¶

<!-- LF_BLOCK id=intro fingerprint=8e30d67ecb9efa724e745d45 -->
当需要从客户端发送数据到 API 时，可以使用请求体。

<!-- LF_BLOCK id=base-model fingerprint=b236d45c7a5114b99abad297 -->
## 导入 Pydantic 的 BaseModel¶

<!-- LF_BLOCK id=base-model-text fingerprint=f4553c5844b38acb04919adc -->
首先导入 BaseModel，并用它声明数据模型。

<!-- LF_BLOCK id=create-model fingerprint=bd7cec7fd92577872252cbb8 -->
## 创建数据模型¶

<!-- LF_BLOCK id=create-model-code fingerprint=8555ade06558ce06fe59f289 -->
```python
from pydantic import BaseModel

class Item(BaseModel):
    name: str
    price: float
```

<!-- LF_BLOCK id=declare-parameter fingerprint=0217ed3fec11649b6791372c -->
## 声明为参数¶

<!-- LF_BLOCK id=declare-parameter-text fingerprint=41d62e3c810dfea88ec885ca -->
将模型类型声明为路径操作函数的参数。

<!-- LF_BLOCK id=result fingerprint=87a7427c94135775ec10fc99 -->
## 结果¶

<!-- LF_BLOCK id=result-code fingerprint=f9c807b043353c18f0cb8b7b -->
```json
{
  "name": "Foo",
  "price": 42.0
}
```

<!-- LF_BLOCK id=tips fingerprint=98c476ef6951eb7a06f0da21 -->
- 请求体会被自动校验

<!-- LF_BLOCK id=tips-2 fingerprint=c28ca1ca34dbdacd6c378ff6 -->
- 代码示例保持原有缩进
<!-- LEARNFLOW_CONTROLLED_END -->

## 个人学习笔记

<!-- LEARNFLOW_PERSONAL_BEGIN -->

<!-- LEARNFLOW_PERSONAL_END -->
