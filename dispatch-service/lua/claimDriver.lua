-- KEYS[1] = driver:<id> hash key
-- Returns 1 if successfully claimed, 0 if driver was no longer available
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'available' then
    redis.call('HSET', KEYS[1], 'status', 'matched')
    return 1
else
    return 0
end        