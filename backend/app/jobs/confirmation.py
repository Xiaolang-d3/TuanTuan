from jsonschema import Draft202012Validator, SchemaError, ValidationError
from referencing import Registry


def validate_schema(schema: dict) -> None:
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as exc:
        raise ValueError("确认步骤的输入规则无效") from exc


def validate_answer(schema: dict, answer: dict) -> None:
    validate_schema(schema)
    try:
        # No external schema resolver: confirmation must never trigger network I/O.
        Draft202012Validator(schema, registry=Registry()).validate(answer)
    except Exception as exc:
        raise ValueError("确认内容不符合当前步骤要求，请补全信息或返回工作流") from exc
