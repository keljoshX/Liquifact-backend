const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { authenticateToken } = require('../middleware/auth');

// Create an isolated Express application for testing the middleware
const app = express();
app.use(express.json());

app.post('/api/invoices', authenticateToken, (req, res) => {
    res.status(201).json({ data: { id: 'placeholder' } });
});

app.get('/api/escrow/:invoiceId', authenticateToken, (req, res) => {
    res.status(200).json({ data: { invoiceId: req.params.invoiceId } });
});

// Register an error handler middleware to convert AppError to JSON format
app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({
        type: err.type,
        title: err.title,
        status: err.status || 500,
        detail: err.detail || err.message,
        instance: err.instance,
    });
});

describe('Authentication Middleware', () => {
    const secret = process.env.JWT_SECRET || 'test-secret';
    const validPayload = { id: 1, role: 'user' };
    let validToken;
    let expiredToken;

    beforeAll(() => {
        validToken = jwt.sign(validPayload, secret, {
            expiresIn: '1h',
            issuer: 'liquifact-platform',
            audience: 'liquifact-client',
        });
        expiredToken = jwt.sign(validPayload, secret, {
            expiresIn: '-1h',
            issuer: 'liquifact-platform',
            audience: 'liquifact-client',
        });
    });

    describe('Route Protection - POST /api/invoices', () => {
        it('should return 401 when token is signed with alg none', async () => {
            const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
            const payload = Buffer.from(JSON.stringify({
                id: 1,
                role: 'user',
                iss: 'liquifact-platform',
                aud: 'liquifact-client',
                exp: Math.floor(Date.now() / 1000) + 3600
            })).toString('base64url');
            const noneToken = `${header}.${payload}.`;

            const response = await request(app)
                .post('/api/invoices')
                .set('Authorization', `Bearer ${noneToken}`)
                .send({});
            expect(response.status).toBe(401);
            expect(response.body.detail).toBe('Invalid token');
        });

        it('should return 401 when token has invalid issuer', async () => {
            const invalidIssuerToken = jwt.sign(validPayload, secret, {
                expiresIn: '1h',
                issuer: 'invalid-issuer',
                audience: 'liquifact-client',
            });
            const response = await request(app)
                .post('/api/invoices')
                .set('Authorization', `Bearer ${invalidIssuerToken}`)
                .send({});
            expect(response.status).toBe(401);
            expect(response.body.detail).toBe('Invalid token');
        });

        it('should return 401 when token has invalid audience', async () => {
            const invalidAudienceToken = jwt.sign(validPayload, secret, {
                expiresIn: '1h',
                issuer: 'liquifact-platform',
                audience: 'invalid-audience',
            });
            const response = await request(app)
                .post('/api/invoices')
                .set('Authorization', `Bearer ${invalidAudienceToken}`)
                .send({});
            expect(response.status).toBe(401);
            expect(response.body.detail).toBe('Invalid token');
        });

        it('should return 401 when no token is provided', async () => {
            const response = await request(app).post('/api/invoices').send({});
            expect(response.status).toBe(401);
            expect(response.body.detail).toBe('Authentication token is required');
        });

        it('should return 401 when token format is invalid (missing Bearer)', async () => {
            const response = await request(app)
                .post('/api/invoices')
                .set('Authorization', `FakeBearer ${validToken}`)
                .send({});
            expect(response.status).toBe(401);
            expect(response.body.detail).toBe('Invalid Authorization header format. Expected "Bearer <token>"');
        });

        it('should return 401 when authorization header is malformed (no space)', async () => {
            const response = await request(app)
                .post('/api/invoices')
                .set('Authorization', `Bearer${validToken}`)
                .send({});
            expect(response.status).toBe(401);
            expect(response.body.detail).toBe('Invalid Authorization header format. Expected "Bearer <token>"');
        });

        it('should return 401 when token is invalid', async () => {
            const response = await request(app)
                .post('/api/invoices')
                .set('Authorization', 'Bearer some.invalid.token')
                .send({});
            expect(response.status).toBe(401);
            expect(response.body.detail).toBe('Invalid token');
        });

        it('should return 401 when token is expired', async () => {
            const response = await request(app)
                .post('/api/invoices')
                .set('Authorization', `Bearer ${expiredToken}`)
                .send({});
            expect(response.status).toBe(401);
            expect(response.body.detail).toBe('Token has expired');
        });

        it('should return 201 when a valid token is provided', async () => {
            const response = await request(app)
                .post('/api/invoices')
                .set('Authorization', `Bearer ${validToken}`)
                .send({ amount: 1000, customer: 'Test Corp' });
            expect(response.status).toBe(201);
            expect(response.body.data).toHaveProperty('id');
        });
    });

    describe('Route Protection - GET /api/escrow/:invoiceId', () => {
        it('should allow escrow read with valid token', async () => {
            const response = await request(app)
                .get('/api/escrow/test-invoice')
                .set('Authorization', `Bearer ${validToken}`);
            expect(response.status).toBe(200);
            expect(response.body.data.invoiceId).toBe('test-invoice');
        });

        it('should reject escrow read without token', async () => {
            const response = await request(app).get('/api/escrow/test-invoice');
            expect(response.status).toBe(401);
        });
    });
});
