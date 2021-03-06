var crypto = require("crypto");
var assert = require("better-assert");
var _ = require("underscore");
var buffer_utils = require("./buffer_utils");
var createFastUninitializedBuffer = buffer_utils.createFastUninitializedBuffer;

// OPC-UA Spec 1.02 part 6 - 6.7.5  Deriving Keys page 42
// Once the  SecureChannel  is established the  Messages  are signed and encrypted with keys derived
// from the  Nonces  exchanged in t he  OpenSecureChannel  call. These keys are derived by passing the
// Nonces  to a pseudo - random function which produces a sequence of bytes from a set of inputs.   A
// pseudo- random function  is represented by the following function declaration:
// Byte[] PRF(
//     Byte[] secret,
//     Byte[] seed,
//     Int32 length,
//     Int32 offset
// )
// Where length   is the number of bytes to return and  offset  is a number of bytes from the beginning of
// the sequence.
// The lengths of the keys that need to be generated depend on the  SecurityPolicy  used for the
//    channel. The following information is specified by the  SecurityPolicy:
//    a)  SigningKeyLength  (from the  DerivedSignatureKeyLength);
//    b)  EncryptingKeyLength  (implied by the  SymmetricEncryptionAlgorithm);
//    c)  EncryptingBlockSize  (implied by the  SymmetricEncryptionAlgorithm).
//  The parameters  passed to the pseudo random function are specified in  Table 36.
//  Table 36  - Cryptography Key Generation Parameters
//
// Key                         Secret       Seed         Length               Offset
// ClientSigningKey            ServerNonce  ClientNonce  SigningKeyLength     0
// ClientEncryptingKey         ServerNonce  ClientNonce  EncryptingKeyLength  SigningKeyLength
// ClientInitializationVector  ServerNonce  ClientNonce  EncryptingBlockSize  SigningKeyLength+ EncryptingKeyLength
// ServerSigningKey            ClientNonce  ServerNonce  SigningKeyLength     0
// ServerEncryptingKey         ClientNonce  ServerNonce  EncryptingKeyLength  SigningKeyLength
// ServerInitializationVector  ClientNonce  ServerNonce  EncryptingBlockSize  SigningKeyLength+ EncryptingKeyLength
//
// The  Client  keys are used to secure  Messages  sent by the  Client. The  Server  keys are used to
// secure Messages  sent by the  Server.
// The SSL/TLS  specification  defines a pseudo random function called P_HASH which is used for this purpose.
//
// The P_HASH  algorithm is defined as follows:
//
//    P_HASH(secret, seed) = HMAC_HASH(secret, A(1) + seed) +
//                            HMAC_HASH(secret, A(2) + seed) +
//                            HMAC_HASH(secret, A(3) + seed) + ...
// Where A(n) is defined as:
//       A(0) = seed
//       A(n) = HMAC_HASH(secret, A(n-1))
//            + indicates that the results are appended to previous results.
// Where HASH is a hash function such as SHA1 or SHA256. The hash function to use depends on the SecurityPolicyUri.
//
//
// see also http://docs.oasis-open.org/ws-sx/ws-secureconversation/200512/ws-secureconversation-1.3-os.html
//          http://csrc.nist.gov/publications/fips/fips180-4/fips-180-4.pdf
function makePseudoRandomBuffer(secret, seed, minLength, sha1or256) {

    assert(sha1or256 === "SHA1" || sha1or256 === "SHA256");
    function HMAC_HASH(secret, message) {
        return crypto.createHmac(sha1or256, secret).update(message).digest();
    }

    function plus(buf1, buf2) {
        return Buffer.concat([buf1, buf2]);
        ///xx var ret = new Buffer(buf1.length+ buf2.length);
        ///xx buf1.copy(ret,0);
        ///xx buf2.copy(ret,buf1.length);
        ///xx return ret;
    }

    assert(seed instanceof Buffer);
    var a = [];
    a[0] = seed;
    var index = 1;
    var p_hash = new Buffer(0);
    while (p_hash.length <= minLength) {
        /* eslint  new-cap:0 */
        a[index] = HMAC_HASH(secret, a[index - 1]);
        p_hash = plus(p_hash, HMAC_HASH(secret, plus(a[index], seed)));
        index += 1;
    }
    return p_hash.slice(0, minLength);
}
exports.makePseudoRandomBuffer = makePseudoRandomBuffer;

function computeDerivedKeys(secret, seed, options) {
    assert(_.isFinite(options.signatureLength));
    assert(_.isFinite(options.encryptingKeyLength));
    assert(_.isFinite(options.encryptingBlockSize));
    assert(typeof options.algorithm === "string");
    options.sha1or256 = options.sha1or256 || "SHA1";
    assert(typeof options.sha1or256 === "string");

    var offset1 = options.signingKeyLength;
    var offset2 = offset1 + options.encryptingKeyLength;
    var offset3 = offset2 + options.encryptingBlockSize;
    var minLength = offset3;
    var buf = makePseudoRandomBuffer(secret, seed, minLength,options.sha1or256);

    return {
        signingKey: buf.slice(0, offset1),
        encryptingKey: buf.slice(offset1, offset2),
        initializationVector: buf.slice(offset2, offset3),
        signingKeyLength: options.signingKeyLength,
        encryptingKeyLength: options.encryptingKeyLength,
        encryptingBlockSize: options.encryptingBlockSize,
        signatureLength: options.signatureLength,
        algorithm: options.algorithm,
        sha1or256: options.sha1or256
    };
}
exports.computeDerivedKeys = computeDerivedKeys;



/**
 * @method reduceLength
 * @param buffer {Buffer}
 * @param byte_to_remove  {number}
 * @return {Buffer}
 */
function reduceLength(buffer, byte_to_remove) {
    return buffer.slice(0, buffer.length - byte_to_remove);
}
exports.reduceLength = reduceLength;


/**
 * @method removePadding
 * @param buffer {Buffer}
 * @return {Buffer}
 */
function removePadding(buffer) {
    var nbPaddingBytes = buffer.readUInt8(buffer.length - 1) + 1;
    return reduceLength(buffer, nbPaddingBytes);
}
exports.removePadding = removePadding;


var crypto_utils = require("./crypto_utils");

/**
 * @method verifyChunkSignature
 *
 *     var signer = {
 *           signatureLength : 128,
 *           algorithm : "RSA-SHA256",
 *           public_key: "qsdqsdqsd"
 *     };
 *
 * @param chunk {Buffer} The message chunk to verify.
 * @param options {Object}
 * @param options.signatureLength {Number}
 * @param options.algorithm {String} the algorithm.
 * @param options.publicKey {Buffer}
 * @return {*}
 */
function verifyChunkSignature(chunk, options) {

    assert(chunk instanceof Buffer);
    var signatureLength = options.signatureLength;
    if (!signatureLength) {
        // let's get the signatureLength by checking the size
        // of the certificate's public key
        var cert = crypto_utils.exploreCertificate(options.publicKey);
        signatureLength = cert.publicKeyLength; // 1024 bits = 128Bytes or 2048=256Bytes
    }
    var block_to_verify = chunk.slice(0, chunk.length - signatureLength);
    var signature = chunk.slice(chunk.length - signatureLength);
    var isValid = crypto_utils.verifyMessageChunkSignature(block_to_verify, signature, options);
    return isValid;
}
exports.verifyChunkSignature = verifyChunkSignature;

// /**
//  * extract the publickey from a certificate - using the pem module
//  *
//  * @method extractPublicKeyFromCertificate_WithPem
//  * @async
//  * @param certificate
//  * @param callback {Function}
//  * @param callback.err
//  * @param callback.publicKey as pem
//  */
// exports.extractPublicKeyFromCertificate_WithPem = function (certificate, callback) {
//
//     var err1 = new Error();
//     var cert_pem = crypto_utils.toPem(certificate, "CERTIFICATE");
//     require("pem").getPublicKey(cert_pem, function (err, data) {
//         if (err) {
//             console.log(err1.stack);
//             console.log(" CANNOT EXTRAT PUBLIC KEY from Certificate".red, certificate);
//             return callback(err);
//         }
//         callback(err, data.publicKey);
//     });
// };
//


function computePaddingFooter(buffer, derivedKeys) {

    assert(derivedKeys.hasOwnProperty("encryptingBlockSize"));
    var paddingSize = derivedKeys.encryptingBlockSize - ( buffer.length + 1 ) % derivedKeys.encryptingBlockSize;
    var padding = createFastUninitializedBuffer(paddingSize + 1);
    padding.fill(paddingSize);
    return padding;
    //xx encrypted_chunks.push(cypher.update(padding));
}
exports.computePaddingFooter = computePaddingFooter;

function derivedKeys_algorithm(derivedKeys) {
    assert(derivedKeys.hasOwnProperty("algorithm"));
    var algorithm = derivedKeys.algorithm || "aes-128-cbc";
    assert(algorithm === "aes-128-cbc" || algorithm === "aes-256-cbc");
    return algorithm;

}
function encryptBufferWithDerivedKeys(buffer, derivedKeys) {

    //xx console.log("xxxxx ",derivedKeys);
    var algorithm = derivedKeys_algorithm(derivedKeys);
    var key = derivedKeys.encryptingKey;
    var initVector = derivedKeys.initializationVector;
    var cypher = crypto.createCipheriv(algorithm, key, initVector);

    cypher.setAutoPadding(false);

    var encrypted_chunks = [];
    encrypted_chunks.push(cypher.update(buffer));
    encrypted_chunks.push(cypher.final());
    return Buffer.concat(encrypted_chunks);
}
exports.encryptBufferWithDerivedKeys = encryptBufferWithDerivedKeys;

function decryptBufferWithDerivedKeys(buffer, derivedKeys) {

    var algorithm = derivedKeys_algorithm(derivedKeys);

    //xx console.log("xxxxx ",algorithm,derivedKeys);

    var key = derivedKeys.encryptingKey;
    var initVector = derivedKeys.initializationVector;
    var cypher = crypto.createDecipheriv(algorithm, key, initVector);

    cypher.setAutoPadding(false);

    var decrypted_chunks = [];
    decrypted_chunks.push(cypher.update(buffer));
    decrypted_chunks.push(cypher.final());

    return Buffer.concat(decrypted_chunks);
}

exports.decryptBufferWithDerivedKeys = decryptBufferWithDerivedKeys;



/**
 * @method makeMessageChunkSignatureWithDerivedKeys
 * @param message {Buffer}
 * @param derivedKeys
 * @return {Buffer}
 */
function makeMessageChunkSignatureWithDerivedKeys(message, derivedKeys) {

    assert(message instanceof Buffer);
    assert(derivedKeys.signingKey instanceof Buffer);
    assert(typeof derivedKeys.sha1or256  === "string");
    assert(derivedKeys.sha1or256  === "SHA1" || derivedKeys.sha1or256  === "SHA256");
    var signature = crypto.createHmac(derivedKeys.sha1or256, derivedKeys.signingKey).update(message).digest();
    assert(signature.length === derivedKeys.signatureLength);
    return signature;
}
exports.makeMessageChunkSignatureWithDerivedKeys = makeMessageChunkSignatureWithDerivedKeys;


/**
 * @method verifyChunkSignatureWithDerivedKeys
 * @param chunk
 * @param derivedKeys
 * @return {boolean}
 */
function verifyChunkSignatureWithDerivedKeys(chunk, derivedKeys) {

    var message = chunk.slice(0, chunk.length - derivedKeys.signatureLength);
    var signature = chunk.slice(chunk.length - derivedKeys.signatureLength);
    var verif = makeMessageChunkSignatureWithDerivedKeys(message, derivedKeys);
    return verif.toString("hex") === signature.toString("hex");
}
exports.verifyChunkSignatureWithDerivedKeys = verifyChunkSignatureWithDerivedKeys;


