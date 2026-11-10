EXPLAIN (ANALYZE)
SELECT * FROM (
  (
    SELECT a.id AS "id", a.type AS "type", a.status AS "status", a."createdAt" AS "createdAt", a."acknowledgedAt" AS "acknowledgedAt", a."resolvedAt" AS "resolvedAt", a."resolutionNote" AS "resolutionNote", s.id AS "studentId", s.name AS "studentName", s."roomNumber" AS "roomNumber", w.name AS "acknowledgedByName"
    FROM "EmergencyAlert" a
    JOIN "Student" s ON s.id = a."studentId"
    LEFT JOIN "Warden" w ON w.id = a."acknowledgedBy"
    WHERE a.status = 'PENDING'
    ORDER BY a."createdAt" DESC, a.id DESC
    LIMIT 25
  )
  UNION ALL
  (
    SELECT a.id AS "id", a.type AS "type", a.status AS "status", a."createdAt" AS "createdAt", a."acknowledgedAt" AS "acknowledgedAt", a."resolvedAt" AS "resolvedAt", a."resolutionNote" AS "resolutionNote", s.id AS "studentId", s.name AS "studentName", s."roomNumber" AS "roomNumber", w.name AS "acknowledgedByName"
    FROM "EmergencyAlert" a
    JOIN "Student" s ON s.id = a."studentId"
    LEFT JOIN "Warden" w ON w.id = a."acknowledgedBy"
    WHERE a.status = 'ACKNOWLEDGED'
    ORDER BY a."createdAt" DESC, a.id DESC
    LIMIT 25
  )
  UNION ALL
  (
    SELECT a.id AS "id", a.type AS "type", a.status AS "status", a."createdAt" AS "createdAt", a."acknowledgedAt" AS "acknowledgedAt", a."resolvedAt" AS "resolvedAt", a."resolutionNote" AS "resolutionNote", s.id AS "studentId", s.name AS "studentName", s."roomNumber" AS "roomNumber", w.name AS "acknowledgedByName"
    FROM "EmergencyAlert" a
    JOIN "Student" s ON s.id = a."studentId"
    LEFT JOIN "Warden" w ON w.id = a."acknowledgedBy"
    WHERE a.status = 'RESOLVED'
    ORDER BY a."createdAt" DESC, a.id DESC
    LIMIT 25
  )
) AS "recent"
ORDER BY "createdAt" DESC, id DESC
OFFSET 0 LIMIT 25;
