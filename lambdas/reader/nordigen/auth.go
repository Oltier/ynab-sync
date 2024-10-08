package nordigen

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"io"
	"log"
	"os"
	"os/exec"
	"path"
	"strconv"
	"time"

	"github.com/frieser/nordigen-go-lib/v2"
)

const RequisitionRedirect = "https://raw.githubusercontent.com/Oltier/ynab-sync/main/lambdas/ok.html"

// requisitionStore returns a clean path to the requisition file
func (r Reader) requisitionStore() string {
	// Use BankID or RequisitionFile as filename
	var file string
	if r.Config.Nordigen.RequisitionFile == "" {
		file = r.Config.Nordigen.BankID
	} else {
		file = r.Config.Nordigen.RequisitionFile
	}

	return path.Clean(fmt.Sprintf("%s/%s.json", r.Config.DataDir, file))
}

func (r Reader) DownloadFile(bucketName string, objectKey string) ([]byte, error) {
	log.Printf("Reading requisition file from S3 bucket: %s, objectKey: %s", bucketName, objectKey)
	result, err := r.S3Client.GetObject(context.TODO(), &s3.GetObjectInput{
		Bucket: aws.String(bucketName),
		Key:    aws.String(objectKey),
	})
	if err != nil {
		log.Printf("Couldn't get object %v:%v. Here's why: %v\n", bucketName, objectKey, err)
		return nil, err
	}
	defer result.Body.Close()
	body, err := io.ReadAll(result.Body)
	if err != nil {
		log.Printf("Couldn't read object body from %v. Here's why: %v\n", objectKey, err)
	}
	return body, nil
}

func (r Reader) RequisitionFile() ([]byte, error) {
	if r.Config.Nordigen.RequisitionFileStorage == "s3" {
		return r.DownloadFile(r.Config.Nordigen.S3BucketName, r.Config.Nordigen.BankID)
	} else {
		log.Printf("Reading requisition file from OS file system")
		return os.ReadFile(r.requisitionStore())
	}
}

// Requisition tries to get requisition from disk, if it fails it will create a
// new and store that one to disk.
func (r Reader) Requisition() (nordigen.Requisition, error) {
	requisitionFile, err := r.RequisitionFile()

	if errors.Is(err, os.ErrNotExist) {
		log.Print("Requisition is not found")
		return r.createRequisition()
	} else if err != nil {
		return nordigen.Requisition{}, fmt.Errorf("ReadFile: %w", err)
	}

	var requisition nordigen.Requisition
	err = json.Unmarshal(requisitionFile, &requisition)
	if err != nil {
		log.Print("Failed to parse requisition file")
		return r.createRequisition()
	}

	switch requisition.Status {
	case "EX":
		// Create a new requisition if expired
		log.Printf("Requisition is expired")
		return r.createRequisition()
	case "LN":
		// Return requisition if it's still valid
		return requisition, nil
	default:
		// Handle unknown status by recreating requisition
		log.Printf("Unsupported requisition status: %s", requisition.Status)
		return r.createRequisition()
	}
}

func (r Reader) saveRequisition(requisition nordigen.Requisition) error {
	requisitionFile, err := json.Marshal(requisition)
	if err != nil {
		return err
	}

	err = os.WriteFile(r.requisitionStore(), requisitionFile, 0644)
	if err != nil {
		return err
	}
	return nil
}

func (r Reader) createRequisition() (nordigen.Requisition, error) {
	requisition, err := r.Client.CreateRequisition(nordigen.Requisition{
		Redirect:      RequisitionRedirect,
		Reference:     strconv.Itoa(int(time.Now().Unix())),
		Agreement:     "",
		InstitutionId: r.Config.Nordigen.BankID,
	})
	if err != nil {
		return nordigen.Requisition{}, fmt.Errorf("CreateRequisition: %w", err)
	}

	r.requisitionHook(requisition)
	log.Printf("Initiate requisition by going to: %s", requisition.Link)

	// Keep waiting for the user to accept the requisition
	for requisition.Status != "LN" {
		requisition, err = r.Client.GetRequisition(requisition.Id)
		if err != nil {
			return nordigen.Requisition{}, fmt.Errorf("GetRequisition: %w", err)
		}
		time.Sleep(2 * time.Second)
	}

	// Store requisition on disk
	err = r.saveRequisition(requisition)
	if err != nil {
		log.Printf("Failed to write requisition to disk: %s", err)
	}

	return requisition, nil
}

// requisitionHook executes the hook with the status and link as arguments
func (r Reader) requisitionHook(req nordigen.Requisition) {
	if r.Config.Nordigen.RequisitionHook != "" {
		cmd := exec.Command(r.Config.Nordigen.RequisitionHook, req.Status, req.Link)
		_, err := cmd.Output()
		if err != nil {
			log.Printf("failed to run requisition hook: %s", err)
		}
	}
}
