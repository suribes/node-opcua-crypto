"use strict";
/**
 * @module opcua.miscellaneous
 * @class cryptoutils
 *
 * @static
 */

var crypto_utils = exports;

var path = require("path");
var fs = require("fs");
var crypto = require("crypto");
var assert = require("better-assert");
var jsrsasign = require("jsrsasign");
var constants = require("constants");
var hexy = require("hexy");

var buffer_utils = require("./buffer_utils");
var createFastUninitializedBuffer = buffer_utils.createFastUninitializedBuffer;

var PEM_REGEX = /^(-----BEGIN (.*)-----\r?\n([\/+=a-zA-Z0-9\r\n]*)\r?\n-----END \2-----\r?\n)/mg;

var PEM_TYPE_REGEX = /^(-----BEGIN (.*)-----)/m;
// Copyright 2012 The Obvious Corporation.
// identifyPemType

/*=
 * Extract and identify the PEM file type represented in the given
 * buffer. Returns the extracted type string or undefined if the
 * buffer doesn't seem to be any sort of PEM format file.
 */
function identifyPemType(raw_key) {
    if (raw_key instanceof Buffer) {
        raw_key = raw_key.toString("utf8");
    }
    var match = PEM_TYPE_REGEX.exec(raw_key);
    return !match ? undefined : match[2];
}

var combine_der = require("./crypto_explore_certificate").combine_der;
function readPEM(raw_key) {

    var match,pemType,base64str ;
    var parts = [];
    while ((match= PEM_REGEX.exec(raw_key)) !== null) {
        pemType = match[2];
        // pemType shall be "RSA PRIVATE KEY" , "PUBLIC KEY", "CERTIFICATE"
        base64str = match[3];
        base64str = base64str.replace(/\r?\n/g, "");

        parts.push(Buffer.from(base64str, "base64"));
    }
    return combine_der(parts);

    //xx else {
    //xxx    return new Buffer(raw_key);
}
function readCertificate(filename) {

    assert(typeof filename === "string");
    if (filename.match(/.*\.der/)) {
        var der = fs.readFileSync(filename,"binary");
        var cert = Buffer.from(der);
        //xxx console.log("cert",cert.toString("base64"));
        return cert;
    }
    var raw_key = fs.readFileSync(filename,"ascii");
    return readPEM(raw_key);
}
exports.readPEM = readPEM;
exports.readKey = readCertificate;
exports.readCertificate = readCertificate;

/**
 * @method readKeyPem
 * @param filename
 */
function readKeyPem(filename) {
    var raw_key = fs.readFileSync(filename, "utf8");
    var pemType = identifyPemType(raw_key);
    assert(typeof pemType === "string"); // must have a valid pem type
    return raw_key;
}
exports.readKeyPem = readKeyPem;


/**
 * @method toPem
 * @param raw_key
 * @param pem
 * @return {*}
 */
function toPem(raw_key, pem) {
    assert(typeof pem === "string");
    var pemType = identifyPemType(raw_key);
    if (pemType) {
        return raw_key;
    } else {
        pemType = pem;
        assert(["CERTIFICATE", "RSA PRIVATE KEY", "PUBLIC KEY"].indexOf(pemType) >= 0);
        var b = raw_key.toString("base64");
        var str = "-----BEGIN " + pemType + "-----\n";
        while (b.length) {
            str += b.substr(0, 64) + "\n";
            b = b.substr(64);
        }
        str += "-----END " + pemType + "-----";
        str += "\n";
        return str;
    }
}
exports.toPem = toPem;

// istanbul ignore next
function hexDump(buffer, width) {
    if (!buffer) {
        return "<>";
    }
    width = width || 32;
    if (buffer.length > 1024) {

        return hexy.hexy(buffer.slice(0, 1024), {width: width, format: "twos"}) + "\n .... ( " + buffer.length + ")";
    } else {
        return hexy.hexy(buffer, {width: width, format: "twos"});
    }
}

/**
 * @method makeMessageChunkSignature
 * @param chunk
 * @param options {Object}
 * @param options.signatureLength {Number}
 * @param options.algorithm {String}   for example "RSA-SHA256"
 * @param options.privateKey {Buffer}
 * @return {Buffer} - the signature
 */
function makeMessageChunkSignature(chunk, options) {

    assert(options.hasOwnProperty("algorithm"));
    assert(chunk instanceof Buffer);
    assert(["RSA PRIVATE KEY","PRIVATE KEY"].indexOf(identifyPemType(options.privateKey))>=0);
    // signature length = 128 bytes
    var signer = crypto.createSign(options.algorithm);
    signer.update(chunk);
    var signature = signer.sign(options.privateKey, 'binary');
    //xx console.log("xxx makeMessageChunkSignature signature.length = ",signature.length);
    //xx console.log("xxxxx ",options);
    //xx console.log("xxxxx ",hexDump(new Buffer(signature, "binary")));
    assert(!options.signatureLength || signature.length === options.signatureLength);
    return Buffer.from(signature, "binary"); // Buffer
}
exports.makeMessageChunkSignature = makeMessageChunkSignature;

/**
 * @method verifyMessageChunkSignature
 *
 *     var signer = {
 *           signatureLength : 128,
 *           algorithm : "RSA-SHA256",
 *           public_key: "qsdqsdqsd"
 *     };
 * @param block_to_verify {Buffer}
 * @param signature {Buffer}
 * @param options {Object}
 * @param options.signatureLength {Number}
 * @param options.algorithm {String}   for example "RSA-SHA256"
 * @param options.publicKey {Buffer}*
 * @return {Boolean} - true if the signature is valid
 */
exports.verifyMessageChunkSignature = function (block_to_verify, signature, options) {

    assert(block_to_verify instanceof Buffer);
    assert(signature       instanceof Buffer);
    assert(typeof options.publicKey === 'string');
    assert(identifyPemType(options.publicKey));

    var verify = crypto.createVerify(options.algorithm);
    verify.update(block_to_verify, "binary");

    var isValid = verify.verify(options.publicKey, signature);
    return isValid;
};

function makeSHA1Thumbprint(buffer) {

    var digest = crypto.createHash('sha1').update(buffer).digest("binary");
    return Buffer.from(digest, "binary");
}
exports.makeSHA1Thumbprint = makeSHA1Thumbprint;


var sshKeyToPEM = require("ssh-key-to-pem");

//xx var  __certificate_store = __dirname + "/helpers/";
var __certificate_store = path.join(__dirname,"../../certificates/");

exports.setCertificateStore = function (store) {
    var old_store = __certificate_store;
    __certificate_store = store;
    return old_store;
};

function read_sshkey_as_pem(filename) {

    if (filename.substr(0, 1) !== '.') {
        filename = __certificate_store + filename;
    }
    var key = fs.readFileSync(filename, "ascii");
    key = sshKeyToPEM(key);
    return key;
}
exports.read_sshkey_as_pem = read_sshkey_as_pem;

function read_private_rsa_key(filename) {
    if (filename.substr(0, 1) !== '.' && !fs.existsSync(filename)) {
        filename = __certificate_store + filename;
    }
    return fs.readFileSync(filename, "ascii");
}
exports.read_private_rsa_key = read_private_rsa_key;

exports.read_public_rsa_key = function (filename) {
    return read_private_rsa_key(filename);
};

// Basically when you =encrypt something using an RSA key (whether public or private), the encrypted value must
// be smaller than the key (due to the maths used to do the actual encryption). So if you have a 1024-bit key,
// in theory you could encrypt any 1023-bit value (or a 1024-bit value smaller than the key) with that key.
// However, the PKCS#1 standard, which OpenSSL uses, specifies a padding scheme (so you can encrypt smaller
// quantities without losing security), and that padding scheme takes a minimum of 11 bytes (it will be longer
// if the value you're encrypting is smaller). So the highest number of bits you can encrypt with a 1024-bit
// key is 936 bits because of this (unless you disable the padding by adding the OPENSSL_NO_PADDING flag,
// in which case you can go up to 1023-1024 bits). With a 2048-bit key it's 1960 bits instead.

exports.RSA_PKCS1_OAEP_PADDING = constants.RSA_PKCS1_OAEP_PADDING;
exports.RSA_PKCS1_PADDING = constants.RSA_PKCS1_PADDING;

// publicEncrypt and  privateDecrypt only work with
// small buffer that depends of the key size.
function publicEncrypt_native(buffer, public_key, algorithm) {

    algorithm = algorithm || crypto_utils.RSA_PKCS1_PADDING;
    assert(algorithm === crypto_utils.RSA_PKCS1_PADDING || algorithm === crypto_utils.RSA_PKCS1_OAEP_PADDING);
    assert(buffer instanceof Buffer, "Expecting a buffer");

    return crypto.publicEncrypt({
        key: public_key,
        padding: algorithm
    }, buffer);
}

function privateDecrypt_native(buffer, private_key, algorithm) {
    algorithm = algorithm || crypto_utils.RSA_PKCS1_PADDING;
    assert(algorithm === crypto_utils.RSA_PKCS1_PADDING || algorithm === crypto_utils.RSA_PKCS1_OAEP_PADDING);
    assert(buffer instanceof Buffer, "Expecting a buffer");

    try {
        return crypto.privateDecrypt({
            key: private_key,
            padding: algorithm
        }, buffer);
    }
    catch (err) {
        return Buffer.alloc(1);
    }
}

function publicEncrypt_long(buffer, key, block_size, padding, algorithm) {
    algorithm = algorithm || crypto_utils.RSA_PKCS1_PADDING;
    assert(algorithm === crypto_utils.RSA_PKCS1_PADDING || algorithm === crypto_utils.RSA_PKCS1_OAEP_PADDING);

    var chunk_size = block_size - padding;
    var nbBlocks = Math.ceil(buffer.length / (chunk_size));

    var outputBuffer = createFastUninitializedBuffer(nbBlocks * block_size);
    for (var i = 0; i < nbBlocks; i++) {
        var currentBlock = buffer.slice(chunk_size * i, chunk_size * (i + 1));
        var encrypted_chunk = publicEncrypt(currentBlock, key, algorithm);
        assert(encrypted_chunk.length === block_size);
        encrypted_chunk.copy(outputBuffer, i * block_size);
    }
    return outputBuffer;
}

function privateDecrypt_long(buffer, key, block_size, algorithm) {

    algorithm = algorithm || crypto_utils.RSA_PKCS1_PADDING;
    assert(algorithm === crypto_utils.RSA_PKCS1_PADDING || algorithm === crypto_utils.RSA_PKCS1_OAEP_PADDING);

    var nbBlocks = Math.ceil(buffer.length / (block_size));

    var outputBuffer = createFastUninitializedBuffer(nbBlocks * block_size);

    var total_length = 0;
    for (var i = 0; i < nbBlocks; i++) {
        var currentBlock = buffer.slice(block_size * i, Math.min(block_size * (i + 1), buffer.length));
        var decrypted_buf = privateDecrypt(currentBlock, key, algorithm);
        decrypted_buf.copy(outputBuffer, total_length);
        total_length += decrypted_buf.length;
    }
    return outputBuffer.slice(0, total_length);

}


var publicEncrypt = publicEncrypt_native;
var privateDecrypt = privateDecrypt_native;


exports.publicEncrypt = publicEncrypt;
exports.publicEncrypt_long = publicEncrypt_long;
exports.privateDecrypt = privateDecrypt;
exports.privateDecrypt_long = privateDecrypt_long;


/***
 * @method rsa_length
 * A very expensive way to determine the rsa key length ( i.e 2048bits or 1024bits)
 * @param key {string} a PEM public key or a PEM rsa private key
 * @return {int} the key length in bytes.
 */
exports.rsa_length = function (key) {
    assert(!(key instanceof Buffer), " buffer is not allowed");
    var a = jsrsasign.KEYUTIL.getKey(key);
    return a.n.toString(16).length / 2;
};


exports.extractPublicKeyFromCertificateSync = function (certificate) {

    if (certificate instanceof Buffer) {
        certificate = crypto_utils.toPem(certificate, "CERTIFICATE");
    }
    assert(typeof certificate === "string");

    var key = jsrsasign.KEYUTIL.getKey(certificate);
    return jsrsasign.KEYUTIL.getPEM(key);
};


// https://github.com/kjur/jsrsasign/blob/master/x509-1.1.js
// tool to analyse asn1 base64 blocks : http://lapo.it/asn1js
/**
 * extract the publickey from a certificate
 * @method extractPublicKeyFromCertificate
 * @async
 * @param certificate
 * @param callback {Function}
 * @param callback.err
 * @param callback.publicKey as pem
 */
exports.extractPublicKeyFromCertificate = function (certificate, callback) {

    var err1 = null, keyPem;
    try {
        keyPem = exports.extractPublicKeyFromCertificateSync(certificate);
    }
    catch (err) {
        err1 = err;
    }
    setImmediate(function () {
        callback(err1, keyPem);
    });

};
