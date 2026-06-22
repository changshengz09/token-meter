package model

import (
	"fmt"
	"time"

	"github.com/QuantumNous/new-api/common"
)

// 日志按月 RANGE 分区（Part B，仅 MySQL）。
//
// 设计：
//   - 复合主键 (id, created_at)，id 仍前导以保 AUTO_INCREMENT；created_at 为分区列。
//   - 分区名 pYYYYMM 对应「该月数据」，边界 = 次月 1 号 00:00:00 的 epoch 秒（统一 UTC）。
//   - pmax(MAXVALUE) 兜底，防越界插入报错；预建未来分区时从 pmax REORGANIZE 切出。
//   - 所有 DDL 仅在 master 节点、MySQL、且 LogPartitionEnabled 时执行（migrateLOGDB 已在 master 守卫内）。

// logPartitionActive 分区逻辑是否生效（MySQL + 开关）。
func logPartitionActive() bool {
	return common.LogSqlType == common.DatabaseTypeMySQL && common.LogPartitionEnabled
}

// monthStartEpoch 返回 t 所在月 1 号 00:00:00（UTC）的 epoch 秒。
func monthStartEpoch(t time.Time) int64 {
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC).Unix()
}

// addMonths 在 (year, month) 基础上前进 n 个月（n 可为负）。
func addMonths(year int, month time.Month, n int) (int, time.Month) {
	total := (year*12 + int(month) - 1) + n
	return total / 12, time.Month(total%12 + 1)
}

func partitionName(year int, month time.Month) string {
	return fmt.Sprintf("p%04d%02d", year, int(month))
}

// nextMonthBoundary 返回 (year, month) 这个分区的上界 = 次月 1 号 00:00:00（UTC）epoch。
func nextMonthBoundary(year int, month time.Month) int64 {
	ny, nm := addMonths(year, month, 1)
	return time.Date(ny, nm, 1, 0, 0, 0, 0, time.UTC).Unix()
}

// isLogsPartitioned 判断 logs 表当前是否已分区（幂等检查）。
func isLogsPartitioned() (bool, error) {
	var cnt int64
	err := LOG_DB.Raw(
		"SELECT COUNT(*) FROM information_schema.PARTITIONS " +
			"WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'logs' AND PARTITION_NAME IS NOT NULL",
	).Scan(&cnt).Error
	return cnt > 0, err
}

// existingLogPartitions 返回 logs 表现有分区名集合。
func existingLogPartitions() (map[string]struct{}, error) {
	var names []string
	err := LOG_DB.Raw(
		"SELECT PARTITION_NAME FROM information_schema.PARTITIONS " +
			"WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'logs' AND PARTITION_NAME IS NOT NULL",
	).Scan(&names).Error
	if err != nil {
		return nil, err
	}
	set := make(map[string]struct{}, len(names))
	for _, n := range names {
		set[n] = struct{}{}
	}
	return set, nil
}

// ensureLogsPartitioned 首次分区化（幂等）：改复合主键 + 建初始分区。
// 已分区则直接跳过分区化，仅交由 ensureLogPartitions 维护。
func ensureLogsPartitioned() error {
	if !logPartitionActive() {
		return nil
	}
	partitioned, err := isLogsPartitioned()
	if err != nil {
		return fmt.Errorf("check logs partitioned: %w", err)
	}
	if partitioned {
		return nil
	}

	// 1) 改复合主键（id 仍前导，保 AUTO_INCREMENT）。DROP+ADD 同一条 ALTER 内原子完成。
	if err := LOG_DB.Exec(
		"ALTER TABLE logs DROP PRIMARY KEY, ADD PRIMARY KEY (id, created_at)",
	).Error; err != nil {
		return fmt.Errorf("alter logs primary key: %w", err)
	}

	// 2) 建初始分区：当前月 ~ 当前月+lookahead，外加 pmax 兜底。
	now := time.Now().UTC()
	lookahead := common.LogPartitionLookaheadMonths
	if lookahead < 0 {
		lookahead = 0
	}
	defs := make([]string, 0, lookahead+2)
	for i := 0; i <= lookahead; i++ {
		y, m := addMonths(now.Year(), now.Month(), i)
		defs = append(defs, fmt.Sprintf("PARTITION %s VALUES LESS THAN (%d)",
			partitionName(y, m), nextMonthBoundary(y, m)))
	}
	defs = append(defs, "PARTITION pmax VALUES LESS THAN (MAXVALUE)")

	ddl := "ALTER TABLE logs PARTITION BY RANGE (created_at) (\n  " +
		joinComma(defs) + "\n)"
	if err := LOG_DB.Exec(ddl).Error; err != nil {
		return fmt.Errorf("partition logs: %w", err)
	}
	common.SysLog(fmt.Sprintf("logs table partitioned (current month + %d lookahead months)", lookahead))
	return nil
}

// ensureLogPartitions 滚动维护：预建未来分区 + 删过期分区。启动时与每日调度各跑一次。
func ensureLogPartitions() error {
	if !logPartitionActive() {
		return nil
	}
	partitioned, err := isLogsPartitioned()
	if err != nil {
		return fmt.Errorf("check logs partitioned: %w", err)
	}
	if !partitioned {
		// 尚未分区化（例如开关后开），交由 ensureLogsPartitioned 处理
		return ensureLogsPartitioned()
	}

	existing, err := existingLogPartitions()
	if err != nil {
		return fmt.Errorf("list logs partitions: %w", err)
	}

	// 预建未来分区：当前月 ~ 当前月+lookahead，缺失则从 pmax REORGANIZE 切出。
	now := time.Now().UTC()
	lookahead := common.LogPartitionLookaheadMonths
	if lookahead < 0 {
		lookahead = 0
	}
	for i := 0; i <= lookahead; i++ {
		y, m := addMonths(now.Year(), now.Month(), i)
		name := partitionName(y, m)
		if _, ok := existing[name]; ok {
			continue
		}
		// 从 pmax 切出新分区（新分区上界小于 MAXVALUE，且大于现有最高边界）
		ddl := fmt.Sprintf(
			"ALTER TABLE logs REORGANIZE PARTITION pmax INTO ("+
				"PARTITION %s VALUES LESS THAN (%d), "+
				"PARTITION pmax VALUES LESS THAN (MAXVALUE))",
			name, nextMonthBoundary(y, m))
		if err := LOG_DB.Exec(ddl).Error; err != nil {
			return fmt.Errorf("reorganize pmax for %s: %w", name, err)
		}
		existing[name] = struct{}{}
		common.SysLog("logs partition pre-created: " + name)
	}

	return dropExpiredLogPartitions()
}

// dropExpiredLogPartitions 删除早于保留期的月分区（LOG_RETENTION_MONTHS > 0 时）。
// 自动清理走 DROP PARTITION（整月、秒级）；手动管理 API 仍走 DeleteOldLog 行删（精确到秒）。
func dropExpiredLogPartitions() error {
	if !logPartitionActive() {
		return nil
	}
	retention := common.LogRetentionMonths
	if retention <= 0 {
		return nil // 0 = 永不自动 DROP
	}

	existing, err := existingLogPartitions()
	if err != nil {
		return fmt.Errorf("list logs partitions: %w", err)
	}

	// 保留当前月及其前 (retention-1) 个月；更早的分区 DROP。
	now := time.Now().UTC()
	keepYear, keepMonth := addMonths(now.Year(), now.Month(), -(retention - 1))
	keepEpoch := monthStartEpoch(time.Date(keepYear, keepMonth, 1, 0, 0, 0, 0, time.UTC))

	for name := range existing {
		if name == "pmax" {
			continue
		}
		y, m, ok := parsePartitionName(name)
		if !ok {
			continue
		}
		if monthStartEpoch(time.Date(y, m, 1, 0, 0, 0, 0, time.UTC)) < keepEpoch {
			if err := LOG_DB.Exec("ALTER TABLE logs DROP PARTITION " + name).Error; err != nil {
				return fmt.Errorf("drop partition %s: %w", name, err)
			}
			common.SysLog("logs expired partition dropped: " + name)
		}
	}
	return nil
}

// parsePartitionName 把 pYYYYMM 解析为 (year, month)。非该格式返回 ok=false。
func parsePartitionName(name string) (int, time.Month, bool) {
	var y, m int
	if _, err := fmt.Sscanf(name, "p%4d%2d", &y, &m); err != nil {
		return 0, 0, false
	}
	if m < 1 || m > 12 {
		return 0, 0, false
	}
	return y, time.Month(m), true
}

func joinComma(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ",\n  "
		}
		out += p
	}
	return out
}

// StartLogPartitionMaintenance 启动分区维护调度（master 节点）。
// 项目此前无任何日志清理调度，这是全新的周期任务：每日检查一次（幂等，存在即跳过），
// 负责预建未来分区与 DROP 过期分区。
func StartLogPartitionMaintenance() {
	if !logPartitionActive() || !common.IsMasterNode {
		return
	}
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			if err := ensureLogPartitions(); err != nil {
				common.SysLog("log partition maintenance failed: " + err.Error())
			}
		}
	}()
	common.SysLog("log partition maintenance scheduled (daily)")
}
