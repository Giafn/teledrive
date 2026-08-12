// Generated offline.
export const declarations = [
  {
    "name": "initConnection",
    "id": -1043505495,
    "idText": "c1cd5ea9",
    "fields": [
      {
        "name": "flags",
        "type": "#"
      },
      {
        "name": "api_id",
        "type": "int"
      },
      {
        "name": "device_model",
        "type": "string"
      },
      {
        "name": "system_version",
        "type": "string"
      },
      {
        "name": "app_version",
        "type": "string"
      },
      {
        "name": "system_lang_code",
        "type": "string"
      },
      {
        "name": "lang_pack",
        "type": "string"
      },
      {
        "name": "lang_code",
        "type": "string"
      },
      {
        "name": "proxy",
        "type": "flags.0?InputClientProxy"
      },
      {
        "name": "params",
        "type": "flags.1?JSONValue"
      },
      {
        "name": "query",
        "type": "!X"
      }
    ],
    "result": "X",
    "generic": [
      "X:Type"
    ],
    "kind": "method",
    "purpose": "selected API layer-223 declaration"
  },
  {
    "name": "invokeWithLayer",
    "id": -627372787,
    "idText": "da9b0d0d",
    "fields": [
      {
        "name": "layer",
        "type": "int"
      },
      {
        "name": "query",
        "type": "!X"
      }
    ],
    "result": "X",
    "generic": [
      "X:Type"
    ],
    "kind": "method",
    "purpose": "selected API layer-223 declaration"
  },
  {
    "name": "help.getConfig",
    "id": -990308245,
    "idText": "c4f9186b",
    "fields": [],
    "result": "Config",
    "generic": [],
    "kind": "method",
    "purpose": "selected API layer-223 declaration"
  }
] as const;
export type Declaration = (typeof declarations)[number];
