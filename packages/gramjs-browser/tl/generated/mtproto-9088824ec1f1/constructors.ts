// Generated offline.
export const declarations = [
  {
    "name": "vector",
    "id": 481674261,
    "idText": "481674261",
    "fields": [],
    "result": "Vector t",
    "generic": [],
    "kind": "constructor",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "resPQ",
    "id": 85337187,
    "idText": "85337187",
    "fields": [
      {
        "name": "nonce",
        "type": "int128"
      },
      {
        "name": "server_nonce",
        "type": "int128"
      },
      {
        "name": "pq",
        "type": "bytes"
      },
      {
        "name": "server_public_key_fingerprints",
        "type": "Vector<long>"
      }
    ],
    "result": "ResPQ",
    "generic": [],
    "kind": "constructor",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "p_q_inner_data_dc",
    "id": -1443537003,
    "idText": "-1443537003",
    "fields": [
      {
        "name": "pq",
        "type": "bytes"
      },
      {
        "name": "p",
        "type": "bytes"
      },
      {
        "name": "q",
        "type": "bytes"
      },
      {
        "name": "nonce",
        "type": "int128"
      },
      {
        "name": "server_nonce",
        "type": "int128"
      },
      {
        "name": "new_nonce",
        "type": "int256"
      },
      {
        "name": "dc",
        "type": "int"
      }
    ],
    "result": "P_Q_inner_data",
    "generic": [],
    "kind": "constructor",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "p_q_inner_data_temp_dc",
    "id": 1459478408,
    "idText": "1459478408",
    "fields": [
      {
        "name": "pq",
        "type": "bytes"
      },
      {
        "name": "p",
        "type": "bytes"
      },
      {
        "name": "q",
        "type": "bytes"
      },
      {
        "name": "nonce",
        "type": "int128"
      },
      {
        "name": "server_nonce",
        "type": "int128"
      },
      {
        "name": "new_nonce",
        "type": "int256"
      },
      {
        "name": "dc",
        "type": "int"
      },
      {
        "name": "expires_in",
        "type": "int"
      }
    ],
    "result": "P_Q_inner_data",
    "generic": [],
    "kind": "constructor",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "server_DH_params_ok",
    "id": -790100132,
    "idText": "-790100132",
    "fields": [
      {
        "name": "nonce",
        "type": "int128"
      },
      {
        "name": "server_nonce",
        "type": "int128"
      },
      {
        "name": "encrypted_answer",
        "type": "bytes"
      }
    ],
    "result": "Server_DH_Params",
    "generic": [],
    "kind": "constructor",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "server_DH_inner_data",
    "id": -1249309254,
    "idText": "-1249309254",
    "fields": [
      {
        "name": "nonce",
        "type": "int128"
      },
      {
        "name": "server_nonce",
        "type": "int128"
      },
      {
        "name": "g",
        "type": "int"
      },
      {
        "name": "dh_prime",
        "type": "bytes"
      },
      {
        "name": "g_a",
        "type": "bytes"
      },
      {
        "name": "server_time",
        "type": "int"
      }
    ],
    "result": "Server_DH_inner_data",
    "generic": [],
    "kind": "constructor",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "client_DH_inner_data",
    "id": 1715713620,
    "idText": "1715713620",
    "fields": [
      {
        "name": "nonce",
        "type": "int128"
      },
      {
        "name": "server_nonce",
        "type": "int128"
      },
      {
        "name": "retry_id",
        "type": "long"
      },
      {
        "name": "g_b",
        "type": "bytes"
      }
    ],
    "result": "Client_DH_Inner_Data",
    "generic": [],
    "kind": "constructor",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "dh_gen_ok",
    "id": 1003222836,
    "idText": "1003222836",
    "fields": [
      {
        "name": "nonce",
        "type": "int128"
      },
      {
        "name": "server_nonce",
        "type": "int128"
      },
      {
        "name": "new_nonce_hash1",
        "type": "int128"
      }
    ],
    "result": "Set_client_DH_params_answer",
    "generic": [],
    "kind": "constructor",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "dh_gen_retry",
    "id": 1188831161,
    "idText": "1188831161",
    "fields": [
      {
        "name": "nonce",
        "type": "int128"
      },
      {
        "name": "server_nonce",
        "type": "int128"
      },
      {
        "name": "new_nonce_hash2",
        "type": "int128"
      }
    ],
    "result": "Set_client_DH_params_answer",
    "generic": [],
    "kind": "constructor",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "dh_gen_fail",
    "id": -1499615742,
    "idText": "-1499615742",
    "fields": [
      {
        "name": "nonce",
        "type": "int128"
      },
      {
        "name": "server_nonce",
        "type": "int128"
      },
      {
        "name": "new_nonce_hash3",
        "type": "int128"
      }
    ],
    "result": "Set_client_DH_params_answer",
    "generic": [],
    "kind": "constructor",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "rpc_result",
    "id": -212046591,
    "idText": "-212046591",
    "fields": [
      {
        "name": "req_msg_id",
        "type": "long"
      },
      {
        "name": "result",
        "type": "Object"
      }
    ],
    "result": "RpcResult",
    "generic": [],
    "kind": "constructor",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "msg_container",
    "id": 1945237724,
    "idText": "1945237724",
    "fields": [
      {
        "name": "messages",
        "type": "vector<%Message>"
      }
    ],
    "result": "MessageContainer",
    "generic": [],
    "kind": "constructor",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "message",
    "id": 1538843921,
    "idText": "1538843921",
    "fields": [
      {
        "name": "msg_id",
        "type": "long"
      },
      {
        "name": "seqno",
        "type": "int"
      },
      {
        "name": "bytes",
        "type": "int"
      },
      {
        "name": "body",
        "type": "Object"
      }
    ],
    "result": "Message",
    "generic": [],
    "kind": "constructor",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "gzip_packed",
    "id": 812830625,
    "idText": "812830625",
    "fields": [
      {
        "name": "packed_data",
        "type": "bytes"
      }
    ],
    "result": "Object",
    "generic": [],
    "kind": "constructor",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "req_pq_multi",
    "id": -1099002127,
    "idText": "-1099002127",
    "fields": [
      {
        "name": "nonce",
        "type": "int128"
      }
    ],
    "result": "ResPQ",
    "generic": [],
    "kind": "method",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "req_DH_params",
    "id": -686627650,
    "idText": "-686627650",
    "fields": [
      {
        "name": "nonce",
        "type": "int128"
      },
      {
        "name": "server_nonce",
        "type": "int128"
      },
      {
        "name": "p",
        "type": "bytes"
      },
      {
        "name": "q",
        "type": "bytes"
      },
      {
        "name": "public_key_fingerprint",
        "type": "long"
      },
      {
        "name": "encrypted_data",
        "type": "bytes"
      }
    ],
    "result": "Server_DH_Params",
    "generic": [],
    "kind": "method",
    "purpose": "selected MTProto envelope declaration"
  },
  {
    "name": "set_client_DH_params",
    "id": -184262881,
    "idText": "-184262881",
    "fields": [
      {
        "name": "nonce",
        "type": "int128"
      },
      {
        "name": "server_nonce",
        "type": "int128"
      },
      {
        "name": "encrypted_data",
        "type": "bytes"
      }
    ],
    "result": "Set_client_DH_params_answer",
    "generic": [],
    "kind": "method",
    "purpose": "selected MTProto envelope declaration"
  }
] as const;
export type Declaration = (typeof declarations)[number];
