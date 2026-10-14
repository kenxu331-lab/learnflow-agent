# 请求体

来源：<https://fastapi.tiangolo.com/zh/tutorial/body/>

当需要从客户端发送数据到 API 时，可以使用请求体。

## 导入 Pydantic 的 BaseModel

首先导入 BaseModel，并用它声明数据模型。

## 创建数据模型

```python
from pydantic import BaseModel

class Item(BaseModel):
    name: str
    price: float
```

## 声明为参数

将模型类型声明为路径操作函数的参数。

## 结果

```json
{
  "name": "Foo",
  "price": 42.0
}
```

- 请求体会被自动校验
- 代码示例保持原有缩进
