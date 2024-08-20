package nordigen

import (
	"context"
	"fmt"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"log"
	"regexp"
	"strings"

	"github.com/frieser/nordigen-go-lib/v2"
	"github.com/martinohansen/ynabber"
)

type Reader struct {
	Config *ynabber.Config

	Client *nordigen.Client

	S3Client *s3.Client
}

// NewReader returns a new nordigen reader or panics
func NewReader(cfg *ynabber.Config) Reader {
	client, err := nordigen.NewClient(cfg.Nordigen.SecretID, cfg.Nordigen.SecretKey)
	if err != nil {
		panic("Failed to create nordigen client")
	}

	s3cfg, err := config.LoadDefaultConfig(context.TODO())

	if err != nil {
		panic(err)
	}

	s3Client := s3.NewFromConfig(s3cfg)

	return Reader{
		Config:   cfg,
		Client:   client,
		S3Client: s3Client,
	}
}

// payeeStripNonAlphanumeric removes all non-alphanumeric characters from payee
func payeeStripNonAlphanumeric(payee string) (x string) {
	reg := regexp.MustCompile(`[^\p{L}]+`)
	x = reg.ReplaceAllString(payee, " ")
	return strings.TrimSpace(x)
}

func (r Reader) toYnabber(a ynabber.Account, t nordigen.Transaction, state ynabber.TransactionState) (ynabber.Transaction, error) {
	transaction, err := r.Mapper().Map(a, t, state)
	if err != nil {
		return ynabber.Transaction{}, err
	}

	// Execute strip method on payee if defined in config
	if r.Config.Nordigen.PayeeStrip != nil {
		transaction.Payee = transaction.Payee.Strip(r.Config.Nordigen.PayeeStrip)
	}

	return transaction, nil
}

func (r Reader) toYnabbers(a ynabber.Account, t nordigen.AccountTransactions) ([]ynabber.Transaction, error) {
	var y []ynabber.Transaction
	log.Printf("Fetched %d booked transactions", len(t.Transactions.Booked))
	for _, v := range t.Transactions.Booked {
		transaction, err := r.toYnabber(a, v, ynabber.Booked)
		if err != nil {
			return nil, err
		}

		// Append transaction
		y = append(y, transaction)
	}

	log.Printf("Fetched %d booked transactions", len(t.Transactions.Pending))
	for _, v := range t.Transactions.Pending {
		transaction, err := r.toYnabber(a, v, ynabber.Pending)
		if err != nil {
			return nil, err
		}

		y = append(y, transaction)
	}

	return y, nil
}

func (r Reader) Bulk() (t []ynabber.Transaction, err error) {
	req, err := r.Requisition()
	if err != nil {
		return nil, fmt.Errorf("failed to authorize: %w", err)
	}

	log.Printf("Found %v accounts", len(req.Accounts))
	for _, account := range req.Accounts {
		accountMetadata, err := r.Client.GetAccountMetadata(account)
		if err != nil {
			return nil, fmt.Errorf("failed to get account metadata: %w", err)
		}

		// Handle expired, or suspended accounts by recreating the
		// requisition.
		switch accountMetadata.Status {
		case "EXPIRED", "SUSPENDED":
			log.Printf(
				"Account: %s is %s. Going to recreate the requisition...",
				account,
				accountMetadata.Status,
			)
			r.createRequisition()
		}

		account := ynabber.Account{
			ID:   ynabber.ID(accountMetadata.Id),
			Name: accountMetadata.Iban,
			IBAN: accountMetadata.Iban,
		}

		log.Printf("Reading transactions from account: %s", account.Name)

		transactions, err := r.Client.GetAccountTransactions(string(account.ID))
		if err != nil {
			return nil, fmt.Errorf("failed to get transactions: %w", err)
		}

		if r.Config.Debug {
			log.Printf("Transactions received from Nordigen: %+v", transactions)
		}

		x, err := r.toYnabbers(account, transactions)
		if err != nil {
			return nil, fmt.Errorf("failed to convert transaction: %w", err)
		}
		t = append(t, x...)
	}
	return t, nil
}
