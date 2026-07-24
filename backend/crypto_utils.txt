import argparse
import base64
import json
import math
import os
import sys

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import pandas as pd
import requests

BATCH_SIZE = 3000


def load_public_key(key_id: str):
    env_var = f"{key_id}_PUBLIC_KEY"
    public_key_b64 = os.getenv(env_var)
    if not public_key_b64:
        raise ValueError(f"{env_var} not found in env variables")
    public_key_pem = base64.b64decode(public_key_b64)
    return serialization.load_pem_public_key(
        public_key_pem, backend=default_backend()
    )


def load_private_key():
    private_key_b64 = os.getenv("PRIVATE_KEY")
    if not private_key_b64:
        raise ValueError("private_key_b64 not set")
    private_key_pem = base64.b64decode(private_key_b64)
    return serialization.load_pem_private_key(
        private_key_pem, password=None, backend=default_backend()
    )


def encrypt_data(input_json: dict, key_id: str) -> dict:
    public_key = load_public_key(key_id)
    data = json.dumps(input_json)
    aes_key = AESGCM.generate_key(bit_length=256)
    nonce = os.urandom(12)

    aesgcm = AESGCM(aes_key)
    encrypted_data = aesgcm.encrypt(nonce, data.encode("utf-8"), None)

    encrypted_data_bytes = encrypted_data[:-16]
    auth_tag = encrypted_data[-16:]

    encrypted_aes_key = public_key.encrypt(
        aes_key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )

    return {
        "encryptedKey": base64.b64encode(encrypted_aes_key).decode("utf-8"),
        "encryptedData": base64.b64encode(encrypted_data_bytes).decode("utf-8"),
        "nonce": base64.b64encode(nonce).decode("utf-8"),
        "authTag": base64.b64encode(auth_tag).decode("utf-8"),
    }


def decrypt_data(payload: dict):
    private_key = load_private_key()
    encrypted_aes_key = base64.b64decode(payload["encryptedKey"])
    encrypted_data = base64.b64decode(payload["encryptedData"])
    nonce = base64.b64decode(payload["nonce"])
    auth_tag = base64.b64decode(payload["authTag"])

    aes_key = private_key.decrypt(
        encrypted_aes_key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )

    full_ciphertext = encrypted_data + auth_tag
    aesgcm = AESGCM(aes_key)
    decrypted_bytes = aesgcm.decrypt(nonce, full_ciphertext, None)

    try:
        return json.dumps(json.loads(decrypted_bytes.decode("utf-8")))
    except json.JSONDecodeError:
        return decrypted_bytes.decode("utf-8"), False