package model

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/QuantumNous/new-api/common"
)

// logBatcher 批量异步写入器（Part A）。
//
// 设计要点：
//   - 每个业务节点各持有一个 batcher（日志由处理 relay 请求的节点写入，非 master-only）。
//   - 请求线程内已把 *Log 快照完毕（不含 gin.Context），入队即非阻塞。
//   - worker 由「条数阈值」与「时间阈值」双触发落盘。
//   - 队列满时降级同步直写，保证不丢（牺牲该条性能）并计数告警。
//   - 进程崩溃会丢失内存队列；日志非账务（扣费已落库），可接受。正常退出可调用 Stop() 落盘剩余。
type logBatcher struct {
	ch        chan *Log
	batchSize int
	flushIntv time.Duration

	stop chan struct{}
	done chan struct{}

	stopOnce sync.Once
	closed   int32 // 1 = 已停止，submitLog 直接走同步直写

	fallbackCount int64 // 队列满降级同步直写的累计次数
	lastReported  int64 // 上次告警时的 fallbackCount
}

var globalLogBatcher *logBatcher

// InitLogBatcher 在所有节点启动批量写入器（须在 InitLogDB 的 master 守卫之前调用）。
func InitLogBatcher() {
	if !common.LogBatchEnabled {
		return
	}
	batchSize := common.LogBatchSize
	if batchSize <= 0 {
		batchSize = 500
	}
	queueSize := common.LogBatchQueueSize
	if queueSize <= 0 {
		queueSize = 10000
	}
	flushMs := common.LogBatchFlushIntervalMs
	if flushMs <= 0 {
		flushMs = 1000
	}
	globalLogBatcher = &logBatcher{
		ch:        make(chan *Log, queueSize),
		batchSize: batchSize,
		flushIntv: time.Duration(flushMs) * time.Millisecond,
		stop:      make(chan struct{}),
		done:      make(chan struct{}),
	}
	go globalLogBatcher.run()
	common.SysLog(fmt.Sprintf("log batcher started: size=%d, queue=%d, flush=%dms",
		batchSize, queueSize, flushMs))
}

// submitLog 入队一条日志；未启用批量或 batcher 已停止时走同步直写。
func submitLog(log *Log) error {
	b := globalLogBatcher
	if b == nil || atomic.LoadInt32(&b.closed) == 1 {
		return LOG_DB.Create(log).Error
	}
	select {
	case b.ch <- log:
		return nil
	default:
		// 队列满：降级同步直写，保证不丢
		atomic.AddInt64(&b.fallbackCount, 1)
		return LOG_DB.Create(log).Error
	}
}

func (b *logBatcher) run() {
	ticker := time.NewTicker(b.flushIntv)
	defer ticker.Stop()

	buf := make([]*Log, 0, b.batchSize)
	flush := func() {
		if len(buf) > 0 {
			b.writeBatch(buf)
			buf = buf[:0]
		}
	}

	for {
		select {
		case log := <-b.ch:
			buf = append(buf, log)
			if len(buf) >= b.batchSize {
				flush()
			}
		case <-ticker.C:
			flush()
			b.reportFallback()
		case <-b.stop:
			// 排空 channel 中剩余日志后落盘退出
			for {
				select {
				case log := <-b.ch:
					buf = append(buf, log)
					if len(buf) >= b.batchSize {
						flush()
					}
				default:
					flush()
					b.reportFallback()
					close(b.done)
					return
				}
			}
		}
	}
}

// writeBatch 落盘一批日志。保留默认事务以保证「整批失败可回滚」，
// 这样重试 1 次不会产生重复行（SkipDefaultTransaction 下部分子批已提交，重试会重复插入）。
func (b *logBatcher) writeBatch(logs []*Log) {
	if len(logs) == 0 {
		return
	}
	err := LOG_DB.CreateInBatches(logs, b.batchSize).Error
	if err != nil {
		// 重试 1 次（默认事务下整批回滚，重试安全）
		err = LOG_DB.CreateInBatches(logs, b.batchSize).Error
	}
	if err != nil {
		// 脱离 gin.Context 后用 request_id 兜底可追溯性
		common.SysLog(fmt.Sprintf("log batch write failed (%d rows): %s | request_ids=%s",
			len(logs), err.Error(), collectRequestIds(logs)))
	}
}

func (b *logBatcher) reportFallback() {
	cur := atomic.LoadInt64(&b.fallbackCount)
	if cur > b.lastReported {
		common.SysLog(fmt.Sprintf("log batcher queue full, fell back to sync write %d times (total %d)",
			cur-b.lastReported, cur))
		b.lastReported = cur
	}
}

// Flush 落盘当前队列内的全部日志（供优雅退出调用）。
// 注意：调用后 batcher 进入停止态，后续 submitLog 走同步直写。
func (b *logBatcher) Flush() {
	b.Stop()
}

// Stop 停止 batcher 并落盘剩余日志。幂等。
func (b *logBatcher) Stop() {
	b.stopOnce.Do(func() {
		atomic.StoreInt32(&b.closed, 1)
		close(b.stop)
		<-b.done
	})
}

// StopLogBatcher 供程序退出钩子调用（若选择 A.7 路线①补建 graceful shutdown）。
func StopLogBatcher() {
	if globalLogBatcher != nil {
		globalLogBatcher.Stop()
	}
}

func collectRequestIds(logs []*Log) string {
	ids := make([]string, 0, len(logs))
	for _, l := range logs {
		if l != nil && l.RequestId != "" {
			ids = append(ids, l.RequestId)
		}
	}
	return strings.Join(ids, ",")
}
