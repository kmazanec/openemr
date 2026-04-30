import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';

export interface TestKeyMaterial {
    privateKey: KeyLike;
    publicKey: KeyLike;
    publicJwk: JWK;
}

export const generateTestKey = async (kid = 'test-kid-1'): Promise<TestKeyMaterial> => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = kid;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    return { privateKey, publicKey, publicJwk };
};

export interface MintTestTokenOptions {
    audience?: string;
    issuer?: string;
    subject?: string;
    scopes?: string[];
    expiresIn?: string;
    notBefore?: string | undefined;
    jti?: string;
    kid?: string;
}

export const mintTestToken = async (
    privateKey: KeyLike,
    options: MintTestTokenOptions = {},
): Promise<string> => {
    const audience = options.audience ?? 'openemr-clinical-copilot-agent';
    const issuer = options.issuer ?? 'https://emr.test/oauth2/default';
    const subject = options.subject ?? 'Practitioner/00000000-0000-4000-8000-000000000001';
    const scopes = options.scopes ?? ['openid', 'fhirUser', 'patient/Patient.read'];
    const expiresIn = options.expiresIn ?? '5m';
    const jti = options.jti ?? 'test-jti-1';

    const builder = new SignJWT({ scopes })
        .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'test-kid-1', typ: 'JWT' })
        .setSubject(subject)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .setJti(jti);

    if (options.notBefore !== undefined) {
        builder.setNotBefore(options.notBefore);
    } else {
        builder.setNotBefore('0s');
    }

    return builder.sign(privateKey);
};
