const axios = require('axios');
const CircuitBreaker = require('opossum');

const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:5003';

// This function makes ONE attempt — no retry logic in here. The breaker needs
// to see individual successes/failures to track health accurately.
async function attemptCharge(rideId, riderId, amount) {
    const response = await axios.post(
        `${PAYMENT_SERVICE_URL}/charge`,
        { riderId, amount },
        {
            headers: { 'Idempotency-Key': rideId },
            timeout: 2000,
        }
    );
    return response.data;
}

const breakerOptions = {
    timeout: 2500,
    errorThresholdPercentage: 50,
    resetTimeout: 10000,
};

const breaker = new CircuitBreaker(attemptCharge,breakerOptions);

breaker.on('open', () => console.log('Circuit breaker OPEN - Payment Service calls will fail fast'));
breaker.on('halfOpen', () => console.log('Circuit breaker HALF-OPEN - trying one request'));
breaker.on('close', () => console.log('Circuit breaker CLOSED - Payment Service healthy again'));

function StylePropertyMap(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// This is what Dispatch Service actually calls — retry loop wrapping the breaker
async function chargeRiderWithRetries(rideId, riderId, amount, maxAttempts = 3) {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const result = await breaker.fire(rideId, riderId, amount);
            console.log(`Payment succeeded for ride ${rideId} on attempt ${attempt}`);            
            return result;
        } catch (err) {
            lastError = err;

            if (err.code === 'EOPENBREAKER') {
                console.log('Circuit is open - failing fast for ride ${rideId}, not retrying further');
                throw err; 
            }

            if (attempt < maxAttempts){
                const backoff = 2 ** attempt * 100;
                console.log(`Payment attempt ${attempt} failed for ride ${rideId}. retrying in ${backoff}ms`);
                await sleep(backoff);
            }
        }
    }

    throw lastError;
}

module.exports = { chargeRiderWithRetries };
